/**
 * @file sdp.test.ts
 * @description Unit tests for RTCSessionDescription and the SDP generate/parse
 * helpers (pure logic — fully exercised here).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RTCSessionDescription, RTCSdpType } from '../src/sdp/RTCSessionDescription';
import * as sdp from '../src/sdp/sdp-utils';

describe('RTCSessionDescription', () => {
  it('stores type and sdp', () => {
    const d = new RTCSessionDescription({ type: 'offer', sdp: 'v=0\r\n' });
    assert.strictEqual(d.type, 'offer');
    assert.strictEqual(d.sdp, 'v=0\r\n');
  });

  it('defaults to null when nothing is provided', () => {
    const d = new RTCSessionDescription();
    assert.strictEqual(d.type, null);
    assert.strictEqual(d.sdp, null);
  });

  it('rejects an invalid type in the constructor', () => {
    assert.throws(() => new RTCSessionDescription({ type: 'bogus' }), TypeError);
  });

  it('accepts all valid SDP types', () => {
    for (const t of Object.values(RTCSdpType)) {
      assert.strictEqual(new RTCSessionDescription({ type: t }).type, t);
    }
  });

  it('validates the type setter and allows the sdp setter', () => {
    const d = new RTCSessionDescription();
    d.type = 'answer';
    assert.strictEqual(d.type, 'answer');
    assert.throws(() => { d.type = 'nope'; }, TypeError);
    d.sdp = 'v=0\r\nx';
    assert.strictEqual(d.sdp, 'v=0\r\nx');
  });

  it('serializes via toJSON', () => {
    const d = new RTCSessionDescription({ type: 'offer', sdp: 's' });
    assert.deepStrictEqual(d.toJSON(), { type: 'offer', sdp: 's' });
  });
});

describe('sdp-utils', () => {
  const fingerprint = { algorithm: 'sha-256', value: 'AA:BB:CC' };

  it('generates ICE credentials of valid length', () => {
    const c = sdp.generateIceCredentials();
    assert.ok(c.usernameFragment.length >= 4);
    assert.ok(c.password.length >= 22);
  });

  it('builds an offer with the data-channel m-line and parses back', () => {
    const offer = sdp.generateOffer({
      iceUfrag: 'ufrag', icePwd: 'pwd-value-pwd-value-pwd', fingerprint,
      candidates: [{ candidate: 'candidate:1 1 udp 2122 1.2.3.4 5000 typ host' }],
    });
    assert.match(offer, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel/);
    assert.match(offer, /a=setup:actpass/);
    assert.match(offer, /a=candidate:1 1 udp 2122 1\.2\.3\.4 5000 typ host/);

    assert.deepStrictEqual(sdp.parseIceParameters(offer), { usernameFragment: 'ufrag', password: 'pwd-value-pwd-value-pwd' });

    const dtls = sdp.parseDtlsParameters(offer);
    assert.strictEqual(dtls.setup, 'actpass');
    assert.strictEqual(dtls.role, 'actpass');
    assert.deepStrictEqual(dtls.fingerprints, [{ algorithm: 'sha-256', value: 'AA:BB:CC' }]);

    const sctp = sdp.parseSctpParameters(offer);
    assert.strictEqual(sctp.port, 5000);
    assert.strictEqual(sctp.maxMessageSize, 262144);
  });

  it('answer defaults to setup:active (DTLS client)', () => {
    const answer = sdp.generateAnswer({ iceUfrag: 'u', icePwd: 'p', fingerprint });
    assert.match(answer, /a=setup:active/);
    assert.strictEqual(sdp.parseDtlsParameters(answer).role, 'client');
  });

  it('maps setup:passive to the server role', () => {
    const s = sdp.generateOffer({ iceUfrag: 'u', icePwd: 'p', fingerprint, setup: 'passive' });
    assert.strictEqual(sdp.parseDtlsParameters(s).role, 'server');
  });

  it('prefixes a bare candidate string and accepts the candidate field', () => {
    const offer = sdp.generateOffer({
      iceUfrag: 'u', icePwd: 'p', fingerprint,
      candidates: [{ sdp: 'candidate:already-prefixed 1 udp 1 1.1.1.1 1 typ host' }, { candidate: '' }],
    });
    assert.match(offer, /a=candidate:already-prefixed/);
  });

  it('parses candidate lines into structured objects', () => {
    const line = 'candidate:f1 1 udp 2122260223 10.0.0.1 54321 typ host';
    const cands = sdp.parseCandidates(`a=${line}\r\na=other\r\n`);
    assert.strictEqual(cands.length, 1);
    assert.strictEqual(cands[0].address, '10.0.0.1');
    assert.strictEqual(cands[0].port, 54321);
    assert.strictEqual(cands[0].type, 'host');
    assert.strictEqual(cands[0].protocol, 'udp');
  });

  it('parseCandidateLine returns null for a malformed candidate', () => {
    assert.strictEqual(sdp.parseCandidateLine('candidate:too few fields'), null);
  });

  it('builds without a fingerprint when none is given', () => {
    const offer = sdp.generateOffer({ iceUfrag: 'u', icePwd: 'p' });
    assert.doesNotMatch(offer, /a=fingerprint:/);
  });
});
