/**
 * @file peerconnection-error.test.ts
 * @description A transport error — notably a peer SCTP ABORT when the remote end
 * goes away (browser tab closed/refreshed) — must not crash the host process.
 * Node throws if an EventEmitter emits 'error' with no listener, so the error
 * must only be emitted when a listener is attached; the failure is always
 * observable via state. These tests reproduce the real ABORT path over a
 * connected, in-process TransportStack pair.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TransportStack } from '../src/transport-stack';
import * as C from '../src/sctp/chunks';
import { applyChecksum } from '../src/sctp/crc32c';
import * as x509 from '../src/crypto/x509';

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

describe('TransportStack peer-ABORT handling', () => {
  it('an SCTP ABORT surfaces as a stack error and does not crash with no listener', async () => {
    const { A, B } = await connectPair();
    try {
      // Capture the verification tag B uses by sniffing one of its packets.
      const tag: number = await new Promise((resolve) => {
        B.sctp!.once('output', (pkt: Buffer) => resolve(C.parseCommonHeader(pkt).verificationTag));
        // Nudge B into emitting a packet (a heartbeat/sack); feed it a stray DATA.
        A.sctp!.sendData(0, C.PPID.STRING, Buffer.from('ping'));
      });

      const abort = C.encodeChunk(C.CHUNK_TYPE.ABORT, 0, Buffer.alloc(0));
      const packet = Buffer.concat([C.encodeCommonHeader(5000, 5000, tag >>> 0), abort]);
      applyChecksum(packet);

      // No 'error' listener attached to B: delivering the ABORT must not throw.
      assert.doesNotThrow(() => B.sctp!.receivePacket(packet));
      assert.strictEqual(B.sctp!.state, 'closed', 'association should be closed by ABORT');
    } finally {
      A.close();
      B.close();
    }
  });

  it('forwards the ABORT error to an attached stack listener', async () => {
    const { A, B } = await connectPair();
    try {
      const errored = new Promise<Error>((resolve) => B.on('error', resolve));

      const tag: number = await new Promise((resolve) => {
        B.sctp!.once('output', (pkt: Buffer) => resolve(C.parseCommonHeader(pkt).verificationTag));
        A.sctp!.sendData(0, C.PPID.STRING, Buffer.from('ping'));
      });
      const abort = C.encodeChunk(C.CHUNK_TYPE.ABORT, 0, Buffer.alloc(0));
      const packet = Buffer.concat([C.encodeCommonHeader(5000, 5000, tag >>> 0), abort]);
      applyChecksum(packet);

      B.sctp!.receivePacket(packet);
      const err = await errored;
      assert.match(err.message, /ABORT/i);
    } finally {
      A.close();
      B.close();
    }
  });
});
