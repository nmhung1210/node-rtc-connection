/**
 * @file x509.test.ts
 * @description Tests for the pure-Node DER encoder and X.509 certificate builder.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as crypto from 'crypto';
import * as der from '../src/crypto/der';
import * as x509 from '../src/crypto/x509';

describe('DER encoder', () => {
  it('encodes short lengths in one byte', () => {
    assert.deepStrictEqual(der.encodeLength(5), Buffer.from([0x05]));
  });

  it('encodes long lengths in long form', () => {
    assert.deepStrictEqual(der.encodeLength(200), Buffer.from([0x81, 0xc8]));
    assert.deepStrictEqual(der.encodeLength(300), Buffer.from([0x82, 0x01, 0x2c]));
  });

  it('encodes small integers', () => {
    assert.deepStrictEqual(der.encodeInteger(2), Buffer.from([0x02, 0x01, 0x02]));
    // High-bit values get a leading zero to stay positive.
    assert.deepStrictEqual(der.encodeInteger(128), Buffer.from([0x02, 0x02, 0x00, 0x80]));
  });

  it('encodes OIDs', () => {
    // 1.2.840.10045.2.1 (id-ecPublicKey)
    assert.deepStrictEqual(
      der.encodeOID('1.2.840.10045.2.1'),
      Buffer.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01])
    );
  });
});

describe('X.509 self-signed certificate', () => {
  it('generates a parseable EC certificate with a verifiable signature', () => {
    const { certDer, publicKey, privateKey } = x509.generateSelfSigned({ commonName: 'unit' });

    assert.ok(Buffer.isBuffer(certDer));
    assert.strictEqual(certDer[0], 0x30); // top-level SEQUENCE
    assert.strictEqual(privateKey.asymmetricKeyType, 'ec');
    assert.strictEqual(publicKey.asymmetricKeyType, 'ec');

    // Node's X509Certificate validates the DER structure and lets us check the
    // signature against the embedded public key (self-signed => verifies).
    const cert = new crypto.X509Certificate(certDer);
    assert.match(cert.subject, /CN=unit/);
    assert.match(cert.issuer, /CN=unit/);
    assert.strictEqual(cert.verify(publicKey), true);
  });

  it('computes the fingerprint over the DER certificate (RFC 8122)', () => {
    const { certDer } = x509.generateSelfSigned();
    const fp = x509.fingerprint(certDer, 'sha-256');

    // Format: colon-separated uppercase hex pairs.
    assert.match(fp, /^([0-9A-F]{2}:)+[0-9A-F]{2}$/);

    // Must equal Node's own fingerprint, which is also taken over the DER cert.
    const expected = new crypto.X509Certificate(certDer).fingerprint256;
    assert.strictEqual(fp, expected);
  });

  it('produces unique certificates each call', () => {
    const a = x509.fingerprint(x509.generateSelfSigned().certDer);
    const b = x509.fingerprint(x509.generateSelfSigned().certDer);
    assert.notStrictEqual(a, b);
  });
});
