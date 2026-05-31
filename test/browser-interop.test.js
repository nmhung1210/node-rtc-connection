/**
 * @file browser-interop.test.js
 * @description End-to-end interop test: our Node RTCPeerConnection negotiates a
 * data channel with a real browser (Chromium, driven by Playwright) over actual
 * UDP, exercising ICE, DTLS, SCTP and DCEP together.
 *
 * Playwright launches headless Chromium and points it at the in-process
 * signaling harness (test/browser/interop-server.js). The page runs a native
 * RTCPeerConnection as the answerer; the test asserts a data channel opens and
 * string + binary messages flow in both directions.
 *
 * Skipped when Playwright/Chromium are not installed or SKIP_INTEGRATION=1.
 * This is the authoritative proof of browser interoperability; lower layers
 * also have focused tests (dtls-openssl-interop, transport-stack, etc.).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./browser/interop-server');

const SKIP = process.env.SKIP_INTEGRATION === '1';

/** Load Playwright + resolve the Chromium executable, or null if unavailable. */
function loadPlaywright() {
  try {
    const { chromium } = require('playwright');
    // Throws if the browser binary hasn't been installed.
    chromium.executablePath();
    return chromium;
  } catch (_) {
    return null;
  }
}

const chromium = SKIP ? null : loadPlaywright();

describe('Browser interop (Playwright + Chromium)', { skip: SKIP || !chromium }, () => {
  let browser;

  before(async () => {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('negotiates a data channel and exchanges string + binary with a browser', async () => {
    // Collect the harness events emitted by both the Node peer and the page.
    const results = [];
    const { server, pc, port } = await startServer((r) => results.push(r));

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

      const has = (pred) => results.some(pred);
      const want = {
        browserChannelOpen: () => has((r) => r.event === 'browser-channel-open'),
        browserReceived: () => has((r) => r.event === 'browser-received' && /hello-from-node/.test(r.data || '')),
        nodeReceivedText: () => has((r) => r.event === 'node-received' && /hello-from-browser/.test(r.data || '')),
        nodeReceivedBinary: () => has((r) => r.event === 'node-received' && /binary/.test(r.data || '')),
      };
      const done = () => want.browserReceived() && want.nodeReceivedText() && want.nodeReceivedBinary();

      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !done()) {
        await new Promise((r) => setTimeout(r, 200));
      }

      assert.ok(want.browserChannelOpen(), `browser did not open the channel; events: ${JSON.stringify(results)}`);
      assert.ok(want.browserReceived(), 'browser did not receive the Node string');
      assert.ok(want.nodeReceivedText(), 'Node did not receive the browser string');
      assert.ok(want.nodeReceivedBinary(), 'Node did not receive the browser binary frame');
    } finally {
      await context.close();
      try { pc.close(); } catch (_) {}
      try { server.close(); } catch (_) {}
    }
  });
});
