/**
 * Test runner: discovers all *.test.ts suites and runs them. Before running, it
 * starts a local coturn TURN server (via Docker) so the relay test
 * (turn-e2e.test.ts) actually exercises a relay, then tears it down afterward.
 *
 * coturn is skipped when SKIP_INTEGRATION=1, when Docker is unavailable, or when
 * an external TURN server is already configured via TURN_HOST. In those cases
 * the relay test self-skips.
 */

import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { spawnSync } from 'node:child_process';
import * as path from 'path';
import * as fs from 'fs';
import STUNClient from '../src/stun/stun-client';

const COTURN_NAME = 'nodertc-test-coturn';
const COTURN_PORT = 3478;

// Get all test files (recursively, so test/integration and test/browser are
// included alongside the top-level suites).
function collectTests(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'helpers' || entry.name === 'browser') continue; // support code, not suites
      out.push(...collectTests(full));
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

function dockerAvailable() {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

/** Start coturn; returns true if we started it (and own its teardown). */
function startCoturn() {
  if (process.env.SKIP_INTEGRATION === '1') return false;
  if (process.env.TURN_HOST) return false; // external TURN server configured
  if (!dockerAvailable()) {
    console.log('[runner] Docker unavailable — TURN relay test will skip\n');
    return false;
  }

  spawnSync('docker', ['rm', '-f', COTURN_NAME], { stdio: 'ignore' });
  const r = spawnSync('docker', [
    'run', '-d', '--name', COTURN_NAME,
    '-p', `${COTURN_PORT}:${COTURN_PORT}/udp`, '-p', `${COTURN_PORT}:${COTURN_PORT}/tcp`,
    'coturn/coturn:latest',
    '-n', `--listening-port=${COTURN_PORT}`, '--fingerprint', '--lt-cred-mech',
    '--user=testuser:testpass', '--user=nodertc:nodertcpass',
    '--realm=nodertc.local', '--no-tls', '--no-dtls',
  ], { stdio: 'ignore' });

  if (r.status !== 0) {
    console.log('[runner] Failed to start coturn — TURN relay test will skip\n');
    return false;
  }
  console.log('[runner] Started coturn for TURN relay test');
  return true;
}

function stopCoturn() {
  spawnSync('docker', ['rm', '-f', COTURN_NAME], { stdio: 'ignore' });
}

/** Wait until coturn answers a TURN allocation (or time out). */
async function waitForCoturn(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const c = new STUNClient({ server: '127.0.0.1', port: COTURN_PORT, username: 'testuser', credential: 'testpass' });
      const t = setTimeout(() => { try { c.close(); } catch (_) {} resolve(false); }, 1500);
      if (t.unref) t.unref();
      c.allocateRelay(300).then(() => { clearTimeout(t); c.close(); resolve(true); })
        .catch(() => { clearTimeout(t); try { c.close(); } catch (_) {} resolve(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const startedCoturn = startCoturn();
  if (startedCoturn) {
    // Ensure teardown on normal exit and interruptions.
    process.on('exit', stopCoturn);
    process.on('SIGINT', () => process.exit(130));
    process.on('SIGTERM', () => process.exit(143));

    const ready = await waitForCoturn();
    if (!ready) console.log('[runner] coturn did not become ready — TURN relay test may skip\n');
  }

  const testFiles = collectTests(__dirname);
  console.log(`Running ${testFiles.length} test files...\n`);

  run({ files: testFiles })
    .on('test:fail', () => { process.exitCode = 1; })
    .compose(spec)
    .pipe(process.stdout);
}

main();
