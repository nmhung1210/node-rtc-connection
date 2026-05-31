/**
 * @file turn-e2e.test.ts
 * @description End-to-end WebRTC over a TURN relay. Two peers are forced to use
 * only relay candidates (iceTransportPolicy: 'relay') so that ICE, DTLS, SCTP
 * and the data channel all travel through the TURN server. Proves the relay
 * data path, not just relay-candidate gathering.
 *
 * Requires a coturn server reachable at TURN_HOST:TURN_PORT (default
 * 127.0.0.1:3478) with the long-term credentials below. CI provides one as a
 * service container (see .github/workflows/test.yml); locally you can run:
 *
 *   docker run -d --name coturn -p 3478:3478/udp coturn/coturn \
 *     -n --listening-port=3478 --fingerprint --lt-cred-mech \
 *     --user=testuser:testpass --realm=nodertc.local --no-tls --no-dtls
 *
 * Skips gracefully when no TURN server answers or SKIP_INTEGRATION=1.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import * as dgram from 'dgram';
import { TransportStack } from '../src/transport-stack';
import { IceAgent } from '../src/ice/ice-agent';
import { RTCDataChannel } from '../src/datachannel/RTCDataChannel';
import * as x509 from '../src/crypto/x509';
import STUNClient from '../src/stun/stun-client';

const TURN_HOST = process.env.TURN_HOST || '127.0.0.1';
const TURN_PORT = parseInt(process.env.TURN_PORT || '3478', 10);
const TURN_USER = process.env.TURN_USER || 'testuser';
const TURN_PASS = process.env.TURN_PASS || 'testpass';
const SKIP = process.env.SKIP_INTEGRATION === '1';

const ICE_SERVERS = [{ urls: `turn:${TURN_HOST}:${TURN_PORT}`, username: TURN_USER, credential: TURN_PASS }];

/** Probe: can we allocate a relay against the configured TURN server? */
function turnReachable(timeoutMs = 2500) {
  return new Promise((resolve) => {
    const c = new STUNClient({ server: TURN_HOST, port: TURN_PORT, username: TURN_USER, credential: TURN_PASS });
    let done = false;
    const finish = (ok: boolean) => { if (done) return; done = true; try { c.close(); } catch (_) {} resolve(ok); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (timer.unref) timer.unref();
    c.allocateRelay(300).then(() => finish(true)).catch(() => finish(false));
  });
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

describe('TURN relay', () => {
  let available = false;
  before(async () => {
    if (SKIP) return;
    available = await turnReachable() as boolean;
  });

  it('gathers a relay candidate from the TURN server', async (t) => {
    if (SKIP || !available) return t.skip('no TURN server reachable');
    const agent = new IceAgent({ role: 'controlling', localUfrag: 'aaaa', localPwd: 'pwd-aaaa-pwd-aaaa-pwd-a' });
    try {
      await agent.gather({ iceServers: ICE_SERVERS });
      const relay = agent.getLocalCandidates().find((c: any) => c.type === 'relay');
      assert.ok(relay, 'expected a relay candidate');
      assert.match(relay.sdp, /typ relay/);
    } finally {
      agent.close();
    }
  });

  it('connects two peers and exchanges data entirely over the relay', async (t) => {
    if (SKIP || !available) return t.skip('no TURN server reachable');

    const A = makeStack('A');
    const B = makeStack('B');
    try {
      const result = await new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('relay connection timeout')), 20000);

        B.on('datachannel-request', (info: any) => {
          const ch = new RTCDataChannel(info.label, { ordered: info.ordered });
          B.acceptChannel(ch, info);
          ch.on('message', (e: any) => ch.send(`echo:${e.data}`));
        });

        A.on('ready', () => {
          const ch = new RTCDataChannel('chat', { ordered: true });
          ch.on('open', () => ch.send('over-turn'));
          ch.on('message', (e: any) => {
            clearTimeout(timer);
            resolve({ reply: e.data, type: A.ice.getSelectedCandidateType() });
          });
          A.openChannel(ch, { ordered: true });
        });
        A.on('error', (e: any) => { clearTimeout(timer); reject(e); });
        B.on('error', (e: any) => { clearTimeout(timer); reject(e); });

        (async () => {
          await A.gather({ iceServers: ICE_SERVERS, iceTransportPolicy: 'relay' });
          await B.gather({ iceServers: ICE_SERVERS, iceTransportPolicy: 'relay' });
          for (const c of A.getLocalCandidates()) B.addRemoteCandidate({ address: c.address, port: c.port, type: c.type, priority: c.priority });
          for (const c of B.getLocalCandidates()) A.addRemoteCandidate({ address: c.address, port: c.port, type: c.type, priority: c.priority });
          A.setRemote('bbbb', 'pwd-bbbb-pwd-bbbb-pwd-b');
          B.setRemote('aaaa', 'pwd-aaaa-pwd-aaaa-pwd-a');
        })().catch(reject);
      });

      assert.strictEqual(result.reply, 'echo:over-turn');
      assert.strictEqual(result.type, 'relay', 'connection must be over a relay candidate');
    } finally {
      A.close();
      B.close();
    }
  });
});
