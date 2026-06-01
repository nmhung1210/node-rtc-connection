/**
 * @file turns-e2e.test.ts
 * @description End-to-end WebRTC over an encrypted TURN relay (the `turns:`
 * scheme, RFC 7350), covering both transports: DTLS over UDP and TLS over TCP
 * (?transport=tcp). The link to the TURN server is itself wrapped in DTLS/TLS:
 * the STUNClient completes the handshake with coturn before any ALLOCATE, so
 * all STUN/TURN signaling to the server is encrypted. Two peers are then forced
 * to relay candidates so ICE, DTLS, SCTP and the data channel all travel
 * through that encrypted relay.
 *
 * coturn needs an explicit ECDSA certificate to bring up TLS/DTLS listeners (it
 * never auto-generates one), so this test pulls a published cert-baked image
 * (nmhung1210/coturn-dtls, built from Dockerfile.coturn-dtls) and runs it on
 * :5349 serving both transports — unless a turns: server is already reachable
 * at TURNS_HOST:TURNS_PORT, in which case it uses that. Override the image via
 * COTURN_DTLS_IMAGE.
 *
 * Skips gracefully when SKIP_INTEGRATION=1 or Docker is unavailable and no
 * external turns: server answers.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { TransportStack } from '../src/transport-stack';
import { IceAgent } from '../src/ice/ice-agent';
import { RTCDataChannel } from '../src/datachannel/RTCDataChannel';
import * as x509 from '../src/crypto/x509';
import STUNClient from '../src/stun/stun-client';

const TURNS_HOST = process.env.TURNS_HOST || '127.0.0.1';
const TURNS_PORT = parseInt(process.env.TURNS_PORT || '5349', 10);
const TURN_USER = process.env.TURN_USER || 'testuser';
const TURN_PASS = process.env.TURN_PASS || 'testpass';
const SKIP = process.env.SKIP_INTEGRATION === '1';

// Published cert-baked coturn image (DTLS listener with an ECDSA P-256 cert).
// Built from Dockerfile.coturn-dtls and pushed to Docker Hub; pulled on demand.
const IMAGE = process.env.COTURN_DTLS_IMAGE || 'nmhung1210/coturn-dtls:latest';
const CONTAINER = 'nodertc-test-coturn-dtls';

/** ICE server list for a given relay transport ('udp' → DTLS, 'tcp' → TLS). */
function iceServers(transport: 'udp' | 'tcp') {
  const suffix = transport === 'tcp' ? '?transport=tcp' : '';
  return [{ urls: `turns:${TURNS_HOST}:${TURNS_PORT}${suffix}`, username: TURN_USER, credential: TURN_PASS }];
}

/** Probe: can we allocate a relay over an encrypted link to the server? */
function turnsReachable(transport: 'udp' | 'tcp' = 'udp', timeoutMs = 3000) {
  return new Promise<boolean>((resolve) => {
    const c = new STUNClient({
      server: TURNS_HOST, port: TURNS_PORT,
      username: TURN_USER, credential: TURN_PASS, secure: true, transport,
    });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; try { c.close(); } catch (_) {} resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (timer.unref) timer.unref();
    c.allocateRelay(300).then(() => finish(true)).catch(() => finish(false));
  });
}

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
}

/**
 * Pull the published cert-baked image and run coturn on :5349 serving BOTH
 * DTLS over UDP and TLS over TCP (the cert is shared; only the transport flag
 * differs). --no-tls is intentionally omitted so the TLS/TCP listener opens.
 */
function startCoturnDtls(): boolean {
  const pull = spawnSync('docker', ['pull', IMAGE], { stdio: 'ignore' });
  if (pull.status !== 0) return false;
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  const run = spawnSync('docker', [
    'run', '-d', '--name', CONTAINER,
    '-p', `${TURNS_PORT}:${TURNS_PORT}/udp`, '-p', `${TURNS_PORT}:${TURNS_PORT}/tcp`,
    IMAGE,
    '-n', `--tls-listening-port=${TURNS_PORT}`, '--fingerprint', '--lt-cred-mech',
    `--user=${TURN_USER}:${TURN_PASS}`, '--realm=nodertc.local',
    '--cert=/etc/coturn/turn_server_cert.pem', '--pkey=/etc/coturn/turn_server_pkey.pem',
  ], { stdio: 'ignore' });
  return run.status === 0;
}

function stopCoturnDtls(): void {
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
}

/**
 * Wait until a secure allocate succeeds (or time out). Give coturn a fixed
 * settle delay first, then probe with generous gaps: rapid back-to-back DTLS
 * handshakes can wedge Docker Desktop's UDP port-forwarding on Windows/macOS,
 * so we deliberately keep the cadence slow.
 */
async function waitForCoturnDtls(timeoutMs = 30000): Promise<boolean> {
  await new Promise((r) => setTimeout(r, 4000));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await turnsReachable('udp', 5000)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

function makeStack(role: string) {
  const cert = x509.generateSelfSigned({ commonName: role });
  return new TransportStack({
    iceRole: role === 'A' ? 'controlling' : 'controlled',
    dtlsRole: role === 'A' ? 'client' : 'server',
    localUfrag: role === 'A' ? 'aaaa' : 'bbbb',
    localPwd: role === 'A' ? 'pwd-aaaa-pwd-aaaa-pwd-a' : 'pwd-bbbb-pwd-bbbb-pwd-b',
    certDer: cert.certDer,
    privateKey: cert.privateKey,
    verifyFingerprint: () => true,
  });
}

// Shared availability state, established once in before(). The coturn we run
// serves both DTLS/UDP and TLS/TCP, so a single container covers both suites.
const state = { available: false, startedContainer: false };

describe('TURN-over-DTLS/TLS relay', () => {
  before(async () => {
    if (SKIP) return;
    // Use an already-running turns: server (e.g. the CI coturn-dtls service
    // container). Poll briefly in case it is still settling at job start.
    for (let i = 0; i < 5; i++) {
      if (await turnsReachable('udp')) { state.available = true; return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    // Otherwise pull + run our own coturn locally (serves DTLS + TLS).
    if (!dockerAvailable()) return;
    if (!startCoturnDtls()) return;
    state.startedContainer = true;
    state.available = await waitForCoturnDtls();
  });

  after(() => {
    if (state.startedContainer) stopCoturnDtls();
  });

  // The relay data path is identical for both transports; only the encrypted
  // link to the TURN server differs (DTLS over UDP vs TLS over TCP).
  for (const transport of ['udp', 'tcp'] as const) {
    const label = transport === 'udp' ? 'DTLS (UDP)' : 'TLS (TCP)';
    const servers = iceServers(transport);

    describe(label, () => {
      it(`gathers a relay candidate over ${label}`, async (t) => {
        if (SKIP || !state.available) return t.skip('no turns: server reachable');
        if (transport === 'tcp' && !(await turnsReachable('tcp'))) return t.skip('TLS/TCP listener not reachable');
        const agent = new IceAgent({ role: 'controlling', localUfrag: 'aaaa', localPwd: 'pwd-aaaa-pwd-aaaa-pwd-a' });
        try {
          await agent.gather({ iceServers: servers });
          const relay = agent.getLocalCandidates().find((c: any) => c.type === 'relay');
          assert.ok(relay, 'expected a relay candidate');
          assert.match(relay.sdp, /typ relay/);
        } finally {
          agent.close();
        }
      });

      it(`connects two peers and exchanges string + binary over the ${label} relay`, async (t) => {
        if (SKIP || !state.available) return t.skip('no turns: server reachable');
        if (transport === 'tcp' && !(await turnsReachable('tcp'))) return t.skip('TLS/TCP listener not reachable');

        const A = makeStack('A');
        const B = makeStack('B');
        try {
          const result = await new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('relay connection timeout')), 25000);

            B.on('datachannel-request', (info: any) => {
              const ch = new RTCDataChannel(info.label, { ordered: info.ordered });
              B.acceptChannel(ch, info);
              ch.on('message', (e: any) => {
                // Echo strings as `echo:<text>`; echo binary verbatim.
                if (typeof e.data === 'string') ch.send(`echo:${e.data}`);
                else ch.send(e.data);
              });
            });

            A.on('ready', () => {
              const ch = new RTCDataChannel('chat', { ordered: true });
              const got: any = {};
              ch.on('open', () => ch.send('over-turns'));
              ch.on('message', (e: any) => {
                if (typeof e.data === 'string') {
                  got.reply = e.data;
                  ch.send(Buffer.from([1, 2, 3, 4]));
                } else {
                  got.binary = Buffer.from(e.data);
                  clearTimeout(timer);
                  resolve({ ...got, type: A.ice.getSelectedCandidateType() });
                }
              });
              A.openChannel(ch, { ordered: true });
            });
            A.on('error', (e: any) => { clearTimeout(timer); reject(e); });
            B.on('error', (e: any) => { clearTimeout(timer); reject(e); });

            (async () => {
              await A.gather({ iceServers: servers, iceTransportPolicy: 'relay' });
              await B.gather({ iceServers: servers, iceTransportPolicy: 'relay' });
              for (const c of A.getLocalCandidates()) B.addRemoteCandidate({ address: c.address, port: c.port, type: c.type, priority: c.priority });
              for (const c of B.getLocalCandidates()) A.addRemoteCandidate({ address: c.address, port: c.port, type: c.type, priority: c.priority });
              A.setRemote('bbbb', 'pwd-bbbb-pwd-bbbb-pwd-b');
              B.setRemote('aaaa', 'pwd-aaaa-pwd-aaaa-pwd-a');
            })().catch(reject);
          });

          assert.strictEqual(result.reply, 'echo:over-turns');
          assert.ok(Buffer.isBuffer(result.binary), 'expected a binary echo');
          assert.deepStrictEqual([...result.binary], [1, 2, 3, 4]);
          assert.strictEqual(result.type, 'relay', 'connection must be over a relay candidate');
        } finally {
          A.close();
          B.close();
        }
      });
    });
  }
});
