#!/usr/bin/env node
/**
 * Single test file runner
 * Usage: node run-single-test.js <test-file-path>
 */

const { run } = require('node:test');
const { spec: specReporter } = require('node:test/reporters');
const path = require('path');

const testFile = process.argv[2];

if (!testFile) {
  console.error('Usage: node run-single-test.js <test-file-path>');
  process.exit(1);
}

const fullPath = path.resolve(testFile);

console.log(`🧪 Running test: ${path.basename(fullPath)}\n`);

const stream = run({
  files: [fullPath],
  concurrency: false,
  timeout: 15000
});

stream.compose(specReporter).pipe(process.stdout);

stream.on('test:fail', () => {
  process.exitCode = 1;
});
