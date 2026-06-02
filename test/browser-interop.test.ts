/**
 * @file browser-interop.test.ts
 * @description End-to-end interop: our Node RTCPeerConnection exchanges data
 * channel messages with a real browser (Chromium via Playwright) over actual
 * UDP, exercising ICE, DTLS, SCTP and DCEP together. Data channels always run
 * over DTLS (WebRTC mandates it).
 *
 * Two network scenarios:
 *   - direct: host candidates, no TURN.
 *   - relay:  both peers forced to iceTransportPolicy:'relay' against coturn.
 *
 * Each scenario sends a fixed set of payloads (ASCII, Unicode, small binary
 * with edge bytes, a 16 KB binary that forces SCTP fragmentation, a 10 KB
 * string); the browser echoes each verbatim and Node verifies byte-for-byte.
 *
 * Skips when Playwright/Chromium are unavailable or SKIP_INTEGRATION=1; the
 * relay scenario additionally skips when no TURN server answers.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { startServer, startAnswererServer, buildPayloads } from './browser/interop-server';
import STUNClient from '../src/stun/stun-client';

const SKIP = process.env.SKIP_INTEGRATION === '1';

const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const TURN_PORT = parseInt(process.env.TURN_PORT || '3478', 10);
const TURN_USER = process.env.TURN_USER || 'testuser';
const TURN_PASS = process.env.TURN_PASS || 'testpass';
const ICE_SERVERS = [{ urls: `turn:${TURN_HOST}:${TURN_PORT}`, username: TURN_USER, credential: TURN_PASS }];

function loadPlaywright() {
  try {
    const { chromium } = require('playwright');
    // executablePath() returns the EXPECTED path even when the browser binary
    // hasn't been downloaded (`npx playwright install`), so we must check the
    // file actually exists — otherwise launch() crashes instead of skipping.
    const exe = chromium.executablePath();
    if (!exe || !require('fs').existsSync(exe)) return null;
    return chromium;
  } catch (_) {
    return null;
  }
}

/** Can we allocate a relay against the configured TURN server? */
function turnReachable(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const c = new STUNClient({ server: TURN_HOST, port: TURN_PORT, username: TURN_USER, credential: TURN_PASS });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; try { c.close(); } catch (_) {} resolve(ok); };
    const t = setTimeout(() => finish(false), timeoutMs);
    if (t.unref) t.unref();
    c.allocateRelay(300).then(() => finish(true)).catch(() => finish(false));
  });
}

const chromium = SKIP ? null : loadPlaywright();

/**
 * Drive one scenario end-to-end and return the collected harness events.
 */
async function runScenario(browser: any, { nodeConfig, browserConfig }: any) {
  const results: any[] = [];
  const { server, pc, port } = await startServer({
    onResult: (r: any) => results.push(r),
    nodeConfig,
    browserConfig,
  }) as any;

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

    const isDone = () =>
      results.some((r) => r.event === 'done') ||
      results.some((r) => r.event === 'browser-error');

    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !isDone()) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return results;
  } finally {
    await context.close();
    try { pc.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
}

/**
 * Drive the reversed-role scenario: the browser offers and owns the channel,
 * our Node peer answers (DTLS client). Returns the collected harness events.
 */
async function runAnswererScenario(browser: any, { nodeConfig, browserConfig }: any) {
  const results: any[] = [];
  const { server, pc, port } = await startAnswererServer({
    onResult: (r: any) => results.push(r),
    nodeConfig,
    browserConfig,
  }) as any;

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const isDone = () =>
      results.some((r) => r.event === 'done') ||
      results.some((r) => r.event === 'browser-error') ||
      results.some((r) => r.event === 'node-error');
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline && !isDone()) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return results;
  } finally {
    await context.close();
    try { pc.close(); } catch (_) {}
    try { server.close(); } catch (_) {}
  }
}

/** Assert every payload echoed back correctly. */
function assertAllEchoed(results: any[]) {
  const browserError = results.find((r) => r.event === 'browser-error');
  assert.ok(!browserError, `browser error: ${browserError && browserError.error}`);
  assert.ok(results.some((r) => r.event === 'channel-open'), 'data channel never opened');

  const echoes = results.filter((r) => r.event === 'echo');
  const expectedIds = buildPayloads().map((p) => p.id);
  for (const id of expectedIds) {
    const e = echoes.find((r) => r.id === id);
    assert.ok(e, `no echo received for payload "${id}" (events: ${JSON.stringify(results)})`);
    assert.ok(e.ok, `payload "${id}" did not round-trip: ${e.detail}`);
  }
  assert.ok(results.some((r) => r.event === 'done'), 'sequence did not complete');
}

/** Like assertAllEchoed, but also fail on a Node-side DTLS/transport error. */
function assertAllEchoedAnswerer(results: any[]) {
  const nodeError = results.find((r) => r.event === 'node-error');
  assert.ok(!nodeError, `node error: ${nodeError && nodeError.error}`);
  assert.ok(results.some((r) => r.event === 'node-channel-open'), 'node never received the channel');
  assertAllEchoed(results);
}

describe('Browser interop (Playwright + Chromium)', { skip: SKIP || !chromium }, () => {
  let browser: any = null;
  let launchError: Error | null = null;
  let relayOk = false;

  before(async () => {
    try {
      browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    } catch (e) {
      // e.g. the browser binary isn't installed — skip rather than fail.
      launchError = e as Error;
    }
    relayOk = await turnReachable() as boolean;
  });

  after(async () => {
    if (browser) await browser.close();
  });

  it('transfers data correctly over a direct connection (no TURN, with DTLS)', async (t) => {
    if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'not launched'}`);
    const results = await runScenario(browser, {
      nodeConfig: { iceServers: [] },
      browserConfig: { iceServers: [] },
    });
    assertAllEchoed(results);
  });

  it('transfers data correctly over a TURN relay (with DTLS)', async (t) => {
    if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'not launched'}`);
    if (!relayOk) return t.skip('no TURN server reachable');
    const results = await runScenario(browser, {
      nodeConfig: { iceServers: ICE_SERVERS, iceTransportPolicy: 'relay' },
      browserConfig: { iceServers: ICE_SERVERS, iceTransportPolicy: 'relay' },
    });
    assertAllEchoed(results);
  });

  // Reversed roles: the browser offers and the Node peer answers (DTLS client).
  // Browsers skip HelloVerifyRequest for data-channel DTLS, so this regresses to
  // `DTLS fatal alert: 51` unless the client folds its first ClientHello into
  // the transcript (RFC 6347 §4.2.1).
  it('transfers data when Node is the answerer (no HelloVerifyRequest)', async (t) => {
    if (!browser) return t.skip(`Chromium unavailable: ${launchError?.message ?? 'not launched'}`);
    const results = await runAnswererScenario(browser, {
      nodeConfig: { iceServers: [] },
      browserConfig: { iceServers: [] },
    });
    assertAllEchoedAnswerer(results);
  });
});
