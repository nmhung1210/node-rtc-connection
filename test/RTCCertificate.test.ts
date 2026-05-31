/**
 * @file RTCCertificate.test.ts
 * @description Test suite for RTCCertificate
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import RTCCertificate from '../src/dtls/RTCCertificate';

describe('RTCCertificate', () => {
  describe('generateCertificate', () => {
    it('should generate a certificate with default options', async () => {
      const cert = await RTCCertificate.generateCertificate();

      assert.ok(cert instanceof RTCCertificate);
      assert.ok(typeof cert.expires === 'number');
      assert.ok(cert.expires > Date.now());
      assert.ok(!cert.isExpired());
    });

    it('should generate certificate with custom name', async () => {
      const cert = await RTCCertificate.generateCertificate({
        name: 'test-peer'
      });

      assert.ok(cert instanceof RTCCertificate);
    });

    it('should generate certificate with custom expiration', async () => {
      const futureTime = Date.now() + (90 * 24 * 60 * 60 * 1000); // 90 days
      const cert = await RTCCertificate.generateCertificate({
        expires: futureTime
      });

      assert.ok(Math.abs(cert.expires - futureTime) < 1000); // Within 1 second
    });

    it('should generate certificate with custom days', async () => {
      const cert = await RTCCertificate.generateCertificate({
        days: 60
      });

      const expectedExpires = Date.now() + (60 * 24 * 60 * 60 * 1000);
      assert.ok(Math.abs(cert.expires - expectedExpires) < 5000); // Within 5 seconds
    });
  });

  describe('getFingerprints', () => {
    it('should return array of fingerprints', async () => {
      const cert = await RTCCertificate.generateCertificate();
      const fingerprints = cert.getFingerprints();

      assert.ok(Array.isArray(fingerprints));
      assert.ok(fingerprints.length > 0);

      fingerprints.forEach(fp => {
        assert.ok(typeof fp.algorithm === 'string');
        assert.ok(typeof fp.value === 'string');
        assert.ok(fp.value.includes(':'));
      });
    });

    it('should include sha-256 fingerprint', async () => {
      const cert = await RTCCertificate.generateCertificate();
      const fingerprints = cert.getFingerprints();

      const sha256 = fingerprints.find(fp => fp.algorithm === 'sha-256');
      assert.ok(sha256);
      assert.ok(sha256.value.length > 0);
    });

    it('should return consistent fingerprints on multiple calls', async () => {
      const cert = await RTCCertificate.generateCertificate();
      const fp1 = cert.getFingerprints();
      const fp2 = cert.getFingerprints();

      assert.deepStrictEqual(fp1, fp2);
    });

    it('should return copies of fingerprints', async () => {
      const cert = await RTCCertificate.generateCertificate();
      const fp1 = cert.getFingerprints();
      const fp2 = cert.getFingerprints();

      // Different array instances
      assert.notStrictEqual(fp1, fp2);
      // But same content
      assert.deepStrictEqual(fp1, fp2);
    });

    it('should format fingerprints as colon-separated uppercase hex', async () => {
      const cert = await RTCCertificate.generateCertificate();
      const fingerprints = cert.getFingerprints();

      fingerprints.forEach(fp => {
        // Check format: XX:XX:XX:...
        const parts = fp.value.split(':');
        assert.ok(parts.length > 1);
        parts.forEach(part => {
          assert.strictEqual(part.length, 2);
          assert.ok(/^[0-9A-F]{2}$/.test(part));
        });
      });
    });
  });

  describe('expires', () => {
    it('should return expiration timestamp', async () => {
      const cert = await RTCCertificate.generateCertificate();

      assert.ok(typeof cert.expires === 'number');
      assert.ok(cert.expires > Date.now());
    });

    it('should reflect custom expiration time', async () => {
      const customExpires = Date.now() + (7 * 24 * 60 * 60 * 1000); // 7 days
      const cert = await RTCCertificate.generateCertificate({
        expires: customExpires
      });

      assert.ok(Math.abs(cert.expires - customExpires) < 1000);
    });
  });

  describe('isExpired', () => {
    it('should return false for valid certificate', async () => {
      const cert = await RTCCertificate.generateCertificate();
      assert.strictEqual(cert.isExpired(), false);
    });

    it('should return true for expired certificate', async () => {
      const pastTime = Date.now() - 1000; // 1 second ago
      const cert = await RTCCertificate.generateCertificate({
        expires: pastTime
      });

      assert.strictEqual(cert.isExpired(), true);
    });
  });

  describe('toPEM', () => {
    it('should export to PEM format', async () => {
      const cert = await RTCCertificate.generateCertificate();
      const pem = cert.toPEM();

      assert.ok(typeof pem === 'object');
      assert.ok(typeof pem.pemPrivateKey === 'string');
      assert.ok(typeof pem.pemCertificate === 'string');
      assert.ok(pem.pemPrivateKey.includes('PRIVATE KEY'));
      // Real X.509 certificate, not a bare public key.
      assert.ok(pem.pemCertificate.includes('BEGIN CERTIFICATE'));
    });
  });

  describe('fromPEM', () => {
    it('should create certificate from PEM strings', async () => {
      const originalCert = await RTCCertificate.generateCertificate();
      const pem = originalCert.toPEM();

      const restoredCert = RTCCertificate.fromPEM(
        pem.pemPrivateKey,
        pem.pemCertificate,
        originalCert.expires
      );

      assert.ok(restoredCert instanceof RTCCertificate);
      assert.strictEqual(restoredCert.expires, originalCert.expires);

      // Fingerprints should match
      const originalFp = originalCert.getFingerprints();
      const restoredFp = restoredCert.getFingerprints();
      assert.deepStrictEqual(originalFp, restoredFp);
    });

    it('should use default expiration if not provided', async () => {
      const originalCert = await RTCCertificate.generateCertificate();
      const pem = originalCert.toPEM();

      const restoredCert = RTCCertificate.fromPEM(
        pem.pemPrivateKey,
        pem.pemCertificate
      );

      assert.ok(restoredCert.expires > Date.now());
    });

    it('should throw if pemPrivateKey is invalid', () => {
      assert.throws(() => {
        RTCCertificate.fromPEM('', 'cert');
      }, TypeError);

      assert.throws(() => {
        RTCCertificate.fromPEM(null as any, 'cert');
      }, TypeError);
    });

    it('should throw if pemCertificate is invalid', () => {
      assert.throws(() => {
        RTCCertificate.fromPEM('key', '');
      }, TypeError);

      assert.throws(() => {
        RTCCertificate.fromPEM('key', null as any);
      }, TypeError);
    });
  });

  describe('isSupportedKeyParams', () => {
    it('should support RSA with valid key sizes', () => {
      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'RSA',
          rsaModulusLength: 2048
        }),
        true
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'RSA',
          rsaModulusLength: 1024
        }),
        true
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'RSA',
          rsaModulusLength: 4096
        }),
        true
      );
    });

    it('should reject RSA with invalid key sizes', () => {
      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'RSA',
          rsaModulusLength: 512
        }),
        false
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'RSA',
          rsaModulusLength: 8192
        }),
        false
      );
    });

    it('should support ECDSA with valid curves', () => {
      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'ECDSA',
          namedCurve: 'P-256'
        }),
        true
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'ECDSA',
          namedCurve: 'P-384'
        }),
        true
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'ECDSA',
          namedCurve: 'P-521'
        }),
        true
      );
    });

    it('should reject ECDSA with invalid curves', () => {
      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'ECDSA',
          namedCurve: 'P-192'
        }),
        false
      );
    });

    it('should reject invalid key types', () => {
      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'DSA'
        } as any),
        false
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({} as any),
        false
      );

      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams(null as any),
        false
      );
    });

    it('should default RSA to 2048 bits if not specified', () => {
      assert.strictEqual(
        RTCCertificate.isSupportedKeyParams({
          type: 'RSA'
        }),
        true
      );
    });
  });

  describe('getPrivateKey and getPublicKey', () => {
    it('should return PEM-encoded keys', async () => {
      const cert = await RTCCertificate.generateCertificate();

      const privateKey = cert.getPrivateKey();
      const publicKey = cert.getPublicKey();

      assert.ok(typeof privateKey === 'string');
      assert.ok(typeof publicKey === 'string');
      assert.ok(privateKey.includes('PRIVATE KEY'));
      assert.ok(publicKey.includes('PUBLIC KEY'));
    });

    it('should expose the DER certificate and a private KeyObject', async () => {
      const cert = await RTCCertificate.generateCertificate();

      const der = cert.getCertificateDer();
      assert.ok(Buffer.isBuffer(der));
      assert.ok(der.length > 0);

      const keyObj = cert.getPrivateKeyObject();
      assert.strictEqual(keyObj.type, 'private');
      assert.strictEqual(keyObj.asymmetricKeyType, 'ec');
    });
  });

  describe('certificate uniqueness', () => {
    it('should generate unique certificates', async () => {
      const cert1 = await RTCCertificate.generateCertificate();
      const cert2 = await RTCCertificate.generateCertificate();

      const fp1 = cert1.getFingerprints()[0].value;
      const fp2 = cert2.getFingerprints()[0].value;

      assert.notStrictEqual(fp1, fp2);
    });
  });
});
