/* eslint no-console: 0, max-len: 0, global-require: 0, import/no-dynamic-require: 0, object-curly-newline: 0 */
const readline = require('readline');
const globby = require('globby');
const Mocha = require('mocha');
const chokidar = require('chokidar');
const importCwd = require('import-cwd');
const NYC = require('nyc');
const fs = require('fs');
const path = require('path');
const options = require('./options');
const utils = require('../terminal-utils');

class Runner {
  constructor(argv, libs) {
    this.argv = argv;
    this.testFiles = [];
    this.onlyTestFiles = [];
    this.srcFiles = [];
    this.onlySrcFiles = [];
    this.mochaRunner = undefined;
    this.mocha = undefined;
    this.nyc = undefined;
    this.isWrapped = false;
    this.isRunning = false;
    this.all = true;
    this.libs = libs;
  }
  log(mode, testFiles, srcFiles) {
    console.log(`${mode}`);
    console.log('  test');
    testFiles.forEach((f) => {
      console.log(`    \u001b[90m${f}\u001b[0m`);
    });
    console.log('  src');
    srcFiles.forEach((f) => {
      console.log(`    \u001b[90m${f}\u001b[0m`);
    });
    console.log('\nSave\u001b[90m a test file or source file to run only affected tests\u001b[0m');
    console.log('\u001b[90mPress\u001b[0m a \u001b[90mto run all\u001b[0m');
    return this;
  }
  setOnlyFilesFromTestFile(testFile) {
    this.onlyTestFiles = [testFile];
    const mod = require.cache[testFile];
    const found = mod
      .children
      .filter(m => this.srcFiles.indexOf(m.id) !== -1)
      .map(m => m.id);
    this.onlySrcFiles = [...new Set([...found])];
  }
  setOnlyFilesFromSrcFile(srcFile) {
    const found = this.testFiles.filter((f) => {
      const mod = require.cache[f];
      return mod
        .children
        .filter(m => m.id === srcFile).length !== 0;
    });
    this.onlyTestFiles = [...new Set([...found])];
    this.onlySrcFiles = [srcFile];
  }
  setOnlyFiles(file) {
    const isTestFile = this.testFiles.indexOf(file) !== -1;
    if (isTestFile) {
      this.setOnlyFilesFromTestFile(file);
    } else {
      this.setOnlyFilesFromSrcFile(file);
    }
  }
  setTestFiles() {
    this.testFiles = globby.sync(this.argv.glob).map(f => path.resolve(f));
    if (!this.testFiles.length) {
      console.log('No files found for:', this.argv.glob);
      process.exit(1);
    }
    return this;
  }
  setSrcFiles() {
    this.srcFiles = globby.sync(this.argv.src).map(f => path.resolve(f));
    return this;
  }
  ensureBabelRequire() {
    // We need to move all `babel` requires to `nyc.require` else the instrumentation will not work
    const containsBabelRequires = this.argv.require.filter(r => r.startsWith('babel'));
    if (this.argv.coverage && this.argv.nyc.babel && containsBabelRequires.length) {
      containsBabelRequires.forEach((r) => {
        const ix = this.argv.require.indexOf(r);
        const move = this.argv.require.splice(ix, 1)[0];
        this.argv.nyc.require = [...new Set(this.argv.nyc.require.concat(move))];
      });
    }
    return this;
  }
  require() {
    this.argv.require.forEach(m => this.libs.importCwd(m));
    return this;
  }
  deleteCoverage() {
    delete global.__coverage__; // eslint-disable-line
    return this;
  }
  runTests() {
    this.isRunning = true;
    this.mochaRunner = this.mocha.run((failures) => {
      process.on('exit', () => {
        process.exit(failures);
      });
    });
    this.mochaRunner.on('end', () => {
      if (this.argv.coverage) {
        this.nyc.writeCoverageFile();
        this.nyc.report();
        if (this.argv.watch) {
          const mode = this.all ? 'All' : 'Only';
          const testFiles = this.all ? [`${this.argv.glob}`] : this.onlyTestFiles;
          const srcFiles = this.all ? [`${this.argv.src}`] : this.onlySrcFiles;
          this.log(mode, testFiles, srcFiles);
        }
      }
      this.isRunning = false;
    });
    return this;
  }
  setupKeyPress() {
    if (!this.argv.watch) {
      return this;
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.on('keypress', (str) => {
      if (str === '\u0003') {
        process.exit(0);
      }
      if (this.isRunning) {
        return;
      }
      switch (str) {
        case 'a':
          this.all = true;
          this.setupAndRunTests(this.testFiles, this.srcFiles);
          break;
        default: break;
      }
    });
    return this;
  }
  setup(testFiles, srcFiles) {
    if (this.argv.coverage) {
      this.nyc.reset();
      if (!this.isWrapped) {
        this.nyc.wrap();
        this.isWrapped = true;
      }
      srcFiles.forEach((f) => {
        if (require.cache[f]) {
          delete require.cache[f];
        }
      });
      utils.writeLine('Source files cache cleared');
    }
    testFiles.forEach((f) => {
      if (require.cache[f]) {
        delete require.cache[f];
      }
      this.mocha.addFile(f);
    });
    utils.writeLine('Test files cache cleared');
    if (this.argv.coverage) {
      srcFiles.forEach((f) => {
        utils.writeLine(`Loading ${f}`);
        require(`${f}`);
      });
    }
    return this;
  }
  setupAndRunTests(testFiles, srcFiles) {
    process.removeAllListeners();
    if (this.mochaRunner) {
      this.mochaRunner.removeAllListeners();
    }
    this.mocha = new this.libs.Mocha(this.argv.mocha);
    this.mocha.suite.on('pre-require', (_, file) => {
      utils.writeLine(`Loading ${file}`);
    });
    this.nyc = new this.libs.NYC(this.argv.nyc);
    this
      .deleteCoverage()
      .setup(testFiles, srcFiles)
      .runTests();
  }
  run() {
    this.setupAndRunTests(this.testFiles, this.srcFiles);
    if (this.argv.watch) {
      this.libs.chokidar.watch(this.argv.watchGlob).on('change', (f) => {
        this.all = false;
        this.setOnlyFiles(path.resolve(f));
        this.setupAndRunTests(this.onlyTestFiles, this.onlySrcFiles, true);
      });
    }
  }
}

const configure = (configPath) => {
  if (configPath === null) {
    return {};
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config ${configPath} not found`);
  }
  let config = {};
  const foundConfig = require(configPath);
  if (typeof foundConfig === 'function') {
    config = Object.assign({}, foundConfig());
  } else {
    config = Object.assign({}, foundConfig);
  }
  return config;
};

const coerceNyc = (opt) => {
  if (opt.babel) {
    opt.require.push('babel-register');
    opt.sourceMap = false;
    opt.instrumenter = './lib/instrumenters/noop';
  }
  return opt;
};

const node = {
  Runner,
  configure,
  coerceNyc,
  command: ['node [options]', '$0'],
  desc: 'Run tests in node',
  builder(yargs) {
    return yargs
      .options(options)
      .config('config', configure)
      .coerce('nyc', coerceNyc);
  },
  handler(argv) {
    const runner = new node.Runner(argv, { Mocha, NYC, importCwd, chokidar });
    runner
      .setupKeyPress()
      .setTestFiles()
      .setSrcFiles()
      .ensureBabelRequire()
      .require()
      .run();
    return runner;
  },
};

module.exports = node;
