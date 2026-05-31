/**
 * @file transport-stack.test.js
 * @description Full ICE+DTLS+SCTP+DCEP pipeline over real UDP sockets, between
 * two TransportStack instances. This exercises the real WebRTC data path.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { TransportStack } = require('../src/transport-stack');
const { RTCDataChannel } = require('../src/datachannel/RTCDataChannel');
const x509 = require('../src/crypto/x509');

async function connectPair() {
  const certA = x509.generateSelfSigned({ commonName: 'A' });
  const certB = x509.generateSelfSigned({ commonName: 'B' });

  const A = new TransportStack({
    iceRole: 'controlling', dtlsRole: 'client',
    localUfrag: 'aaaa', localPwd: 'pwd-aaaa-pwd-aaaa-pwd-a',
    certDer: certA.certDer, privateKey: certA.privateKey, verifyFingerprint: () => true,
  });
  const B = new TransportStack({
    iceRole: 'controlled', dtlsRole: 'server',
    localUfrag: 'bbbb', localPwd: 'pwd-bbbb-pwd-bbbb-pwd-b',
    certDer: certB.certDer, privateKey: certB.privateKey, verifyFingerprint: () => true,
  });

  await A.gather();
  await B.gather();
  for (const c of A.getLocalCandidates()) B.addRemoteCandidate({ address: c.address, port: c.port, type: 'host', priority: c.priority });
  for (const c of B.getLocalCandidates()) A.addRemoteCandidate({ address: c.address, port: c.port, type: 'host', priority: c.priority });
  A.setRemote('bbbb', 'pwd-bbbb-pwd-bbbb-pwd-b');
  B.setRemote('aaaa', 'pwd-aaaa-pwd-aaaa-pwd-a');

  await Promise.all([
    new Promise((r) => A.on('ready', r)),
    new Promise((r) => B.on('sctpconnected', r)),
  ]);
  return { A, B };
}

describe('Full transport stack over UDP', () => {
  it('establishes ICE+DTLS+SCTP and exchanges string + binary over a data channel', async () => {
    const { A, B } = await connectPair();
    try {
      const remoteReady = new Promise((resolve) => {
        B.on('datachannel-request', (info) => {
          const ch = new RTCDataChannel(info.label, { ordered: info.ordered });
          ch.binaryType = 'arraybuffer';
          B.acceptChannel(ch, info);
          resolve(ch);
        });
      });

      const local = new RTCDataChannel('chat', { ordered: true });
      const localOpen = new Promise((r) => local.on('open', r));
      A.openChannel(local, { ordered: true });
      await localOpen;
      const remote = await remoteReady;

      // string
      const sGot = new Promise((r) => remote.on('message', (e) => r(e.data)));
      local.send('hello-real-webrtc');
      assert.strictEqual(await sGot, 'hello-real-webrtc');

      // binary
      const payload = Uint8Array.from([0, 255, 1, 254, 128, 7]);
      const bGot = new Promise((r) => remote.once('message', (e) => r(e.data)));
      // re-subscribe (the earlier handler already consumed one)
      const bGot2 = new Promise((r) => remote.on('message', (e) => r(e.data)));
      local.send(payload.buffer);
      const recv = await bGot2;
      assert.ok(recv instanceof ArrayBuffer);
      assert.deepStrictEqual(new Uint8Array(recv), payload);
    } finally {
      A.close();
      B.close();
    }
  });
});
