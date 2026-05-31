/**
 * Simple test runner that runs all tests in the test directory
 */

const { run } = require('node:test');
const { spec } = require('node:test/reporters');
const path = require('path');
const fs = require('fs');

// Get all test files (recursively, so test/integration and test/browser are
// included alongside the top-level suites).
function collectTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'helpers' || entry.name === 'browser') continue; // support code, not suites
      out.push(...collectTests(full));
    } else if (entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

const testDir = __dirname;
const testFiles = collectTests(testDir);

console.log(`Running ${testFiles.length} test files...\n`);

// Run tests
run({ files: testFiles })
  .on('test:fail', () => {
    process.exitCode = 1;
  })
  .compose(spec)
  .pipe(process.stdout);
