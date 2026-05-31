/**
 * @file run-browser-interop.js
 * @description Launches headless Chrome against the interop harness and asserts
 * a full browser<->Node WebRTC data-channel exchange succeeds.
 *
 * Exit code 0 on success, non-zero on failure. Designed to be invoked by the
 * test wrapper, which skips when Chrome is unavailable.
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./interop-server');

function findChrome() {
  const envPath = process.env.CHROME_PATH;
  const candidates = [
    envPath,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('SKIP: Chrome not found');
    process.exit(99);
  }

  const results = [];
  const { server, pc, port } = await startServer((r) => {
    results.push(r);
    console.log('[result]', JSON.stringify(r));
  });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-interop-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    `http://127.0.0.1:${port}/`,
  ];
  const child = spawn(chrome, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {}); // chrome is noisy on stderr

  const deadline = Date.now() + 25000;
  const want = {
    browserChannelOpen: () => results.some((r) => r.event === 'browser-channel-open'),
    browserReceived: () => results.some((r) => r.event === 'browser-received' && /hello-from-node/.test(r.data || '')),
    nodeReceivedText: () => results.some((r) => r.event === 'node-received' && /hello-from-browser/.test(r.data || '')),
    nodeReceivedBinary: () => results.some((r) => r.event === 'node-received' && /binary/.test(r.data || '')),
  };

  function done() {
    return want.browserReceived() && want.nodeReceivedText() && want.nodeReceivedBinary();
  }

  while (Date.now() < deadline && !done()) {
    await new Promise((r) => setTimeout(r, 250));
  }

  // Teardown.
  try { child.kill(); } catch (_) {}
  try { pc.close(); } catch (_) {}
  try { server.close(); } catch (_) {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}

  const summary = {
    browserChannelOpen: want.browserChannelOpen(),
    browserReceived: want.browserReceived(),
    nodeReceivedText: want.nodeReceivedText(),
    nodeReceivedBinary: want.nodeReceivedBinary(),
  };
  console.log('SUMMARY', JSON.stringify(summary));

  if (done()) {
    console.log('BROWSER INTEROP: SUCCESS');
    process.exit(0);
  } else {
    console.error('BROWSER INTEROP: FAILED');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('runner error:', e);
  process.exit(2);
});
