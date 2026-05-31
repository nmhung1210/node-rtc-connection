/**
 * @file browser-interop.test.js
 * @description End-to-end interop test: our Node RTCPeerConnection negotiates a
 * data channel with a real headless Chrome RTCPeerConnection over actual UDP,
 * exercising ICE, DTLS, SCTP and DCEP together.
 *
 * Skipped when Chrome is not installed or SKIP_INTEGRATION=1. This is the
 * authoritative proof of browser interoperability; lower layers also have
 * focused tests (dtls-openssl-interop, transport-stack, etc.).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SKIP = process.env.SKIP_INTEGRATION === '1';

function chromeAvailable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.some((c) => {
    try { return fs.existsSync(c); } catch (_) { return false; }
  });
}

describe('Browser interop (headless Chrome)', { skip: SKIP || !chromeAvailable() }, () => {
  it('negotiates a data channel and exchanges string + binary with a browser', () => {
    const runner = path.join(__dirname, 'browser', 'run-browser-interop.js');
    const r = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 60000 });
    const out = (r.stdout || '') + (r.stderr || '');

    if (r.status === 99) {
      // Chrome vanished between the availability check and launch; treat as skip.
      return;
    }
    assert.strictEqual(r.status, 0, `browser interop runner failed:\n${out}`);
    assert.match(out, /BROWSER INTEROP: SUCCESS/);

    const m = out.match(/SUMMARY (\{.*\})/);
    assert.ok(m, 'missing SUMMARY line');
    const summary = JSON.parse(m[1]);
    assert.strictEqual(summary.browserChannelOpen, true, 'browser did not open the channel');
    assert.strictEqual(summary.browserReceived, true, 'browser did not receive Node string');
    assert.strictEqual(summary.nodeReceivedText, true, 'Node did not receive browser string');
    assert.strictEqual(summary.nodeReceivedBinary, true, 'Node did not receive browser binary');
  });
});
