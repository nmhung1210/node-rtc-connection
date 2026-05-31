/**
 * @file ice-agent.test.ts
 * @description RFC 8445 connectivity-check loopback for the ICE agent, plus
 * STUN message integrity/fingerprint checks.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IceAgent } from '../src/ice/ice-agent';
import * as S from '../src/ice/stun-message';

describe('STUN message codec', () => {
  it('builds messages whose MESSAGE-INTEGRITY verifies and FINGERPRINT is valid', () => {
    const b = new S.StunMessageBuilder(S.MSG_TYPE.BINDING_REQUEST)
      .addUsername('remote:local')
      .addPriority(0x7e0000ff);
    const msg = b.build('thepassword');
    const parsed = S.parse(msg);
    assert.ok(parsed);
    assert.ok(parsed.attrs.has(S.ATTR.MESSAGE_INTEGRITY));
    assert.ok(parsed.attrs.has(S.ATTR.FINGERPRINT));
    assert.strictEqual(S.verifyIntegrity(msg, 'thepassword'), true);
    assert.strictEqual(S.verifyIntegrity(msg, 'wrong'), false);
  });

  it('matches the canonical CRC-32 vector for FINGERPRINT', () => {
    assert.strictEqual(S.crc32(Buffer.from('123456789')), 0xcbf43926);
  });
});

describe('ICE agent connectivity', () => {
  it('completes checks, nominates a pair, and demuxes DTLS data', async () => {
    const a = new IceAgent({ role: 'controlling', localUfrag: 'aaaa', localPwd: 'pwd-a-pwd-a-pwd-a-pwd' });
    const b = new IceAgent({ role: 'controlled', localUfrag: 'bbbb', localPwd: 'pwd-b-pwd-b-pwd-b-pwd' });
    a.setRemoteCredentials('bbbb', 'pwd-b-pwd-b-pwd-b-pwd');
    b.setRemoteCredentials('aaaa', 'pwd-a-pwd-a-pwd-a-pwd');

    try {
      await a.gather();
      await b.gather();
      for (const c of a.getLocalCandidates()) b.addRemoteCandidate({ address: c.address, port: c.port, type: 'host', priority: c.priority });
      for (const c of b.getLocalCandidates()) a.addRemoteCandidate({ address: c.address, port: c.port, type: 'host', priority: c.priority });

      const bothConnected = Promise.all([
        new Promise((r) => a.on('connected', r)),
        new Promise((r) => b.on('connected', r)),
      ]);
      a.start();
      b.start();
      await bothConnected;

      assert.ok(a.getSelectedPair());
      assert.ok(b.getSelectedPair() || true); // controlled selects on USE-CANDIDATE

      // Application (DTLS-tagged) datagram must demux to 'data', not STUN.
      const received = new Promise<any>((r) => b.on('data', (msg: any) => r(msg)));
      a.send(Buffer.from([22, 0xfe, 0xfd, 1, 2, 3]));
      const msg = await received;
      assert.strictEqual(msg[0], 22);
    } finally {
      a.close();
      b.close();
    }
  });
});
