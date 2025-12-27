#!/usr/bin/env node
/**
 * Test runner for NodeRTC
 * Runs all test files and provides a summary
 */

const { run } = require('node:test');
const { spec: specReporter } = require('node:test/reporters');
const fs = require('fs');
const path = require('path');

async function runTests() {
  const testDir = __dirname;
  const testFiles = fs.readdirSync(testDir)
    .filter(file => file.endsWith('.test.js'))
    .map(file => path.join(testDir, file));

  // Skip slow integration tests by default
  process.env.SKIP_INTEGRATION = '1';

  console.log('🧪 Running NodeRTC Test Suite\n');
  console.log(`Found ${testFiles.length} test files:\n`);
  testFiles.forEach(file => {
    console.log(`  - ${path.basename(file)}`);
  });
  console.log('\n' + '='.repeat(60) + '\n');

  const stream = run({
    files: testFiles,
    concurrency: false,
    timeout: 15000 // Increase timeout for integration tests
  });

  stream.compose(specReporter).pipe(process.stdout);
}

runTests().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
