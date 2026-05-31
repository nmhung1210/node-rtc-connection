/**
 * @file RTCCertificate.ts
 * @description DTLS certificate implementation for WebRTC.
 * @module dtls/RTCCertificate
 *
 * Implements the W3C RTCCertificate interface
 * (https://www.w3.org/TR/webrtc/#rtccertificate-interface). Certificate and key
 * generation are handled by src/crypto/x509.ts.
 */

import * as crypto from 'crypto';
import * as x509 from '../crypto/x509';

/**
 * RTCDtlsFingerprint - DTLS certificate fingerprint
 */
export interface RTCDtlsFingerprint {
  /** Hash algorithm (e.g., 'sha-256') */
  algorithm: string;
  /** Fingerprint value (colon-separated hex) */
  value: string;
}

/** Options accepted by {@link generateSelfSignedCertificate}. */
interface GenerateCertificateOptions {
  /** Common name for the certificate */
  name?: string;
  /** Days until expiration */
  days?: number;
  /** Hash algorithm */
  hash?: string;
}

/** Internal certificate data held by an {@link RTCCertificate}. */
interface CertData {
  certDer: Buffer | null;
  privateKey: crypto.KeyObject | string;
  publicKey: crypto.KeyObject | string;
  expires: number;
  hash?: string;
}

/** Options accepted by {@link RTCCertificate.generateCertificate}. */
interface RTCGenerateCertificateOptions {
  /** Common name for the certificate */
  name?: string;
  /** Expiration time in ms (default: 30 days from now) */
  expires?: number;
  /** Days until expiration */
  days?: number;
  /** Hash algorithm */
  hash?: string;
}

/** Key parameters accepted by {@link RTCCertificate.isSupportedKeyParams}. */
interface RTCCertificateKeyParams {
  type: string;
  rsaModulusLength?: number;
  namedCurve?: string;
}

/** PEM serialization produced by {@link RTCCertificate.toPEM}. */
interface RTCCertificatePEM {
  pemPrivateKey: string;
  pemCertificate: string;
}

/**
 * Generate a self-signed X.509 certificate for DTLS.
 *
 * Unlike a bare key pair, a real certificate is required for browser interop:
 * the DTLS handshake transmits the certificate and the peer validates it
 * against the SDP a=fingerprint (a hash over the DER certificate, RFC 8122).
 *
 * @param options - Certificate generation options
 * @returns Certificate object with DER cert, keys and expiry
 * @private
 */
function generateSelfSignedCertificate(
  options: GenerateCertificateOptions = {}
): CertData {
  const { name, days = 30 } = options;

  const { certDer, privateKey, publicKey, notAfter } = x509.generateSelfSigned({
    commonName: name,
    days,
  });

  return {
    certDer, // Buffer, DER-encoded X.509 certificate
    privateKey, // crypto.KeyObject (EC P-256)
    publicKey, // crypto.KeyObject
    expires: notAfter.getTime(),
    hash: 'sha256',
  };
}

/**
 * Calculate the certificate fingerprint per RFC 8122: a hash over the
 * DER-encoded certificate, uppercase hex, colon-separated.
 * @param certDer - DER-encoded X.509 certificate
 * @param algorithm - SDP hash name (e.g. 'sha-256')
 * @returns Fingerprint (colon-separated hex)
 * @private
 */
function calculateFingerprint(
  certDer: Buffer,
  algorithm: string = 'sha-256'
): string {
  return x509.fingerprint(certDer, algorithm);
}

/**
 * @class RTCCertificate
 * @description Represents a certificate used for DTLS in WebRTC.
 * The certificate includes a key pair and expiration time.
 *
 * @example
 * // Generate a certificate
 * const cert = await RTCCertificate.generateCertificate();
 * console.log('Expires:', new Date(cert.expires));
 * console.log('Fingerprints:', cert.getFingerprints());
 *
 * @example
 * // Generate with custom expiration
 * const cert = await RTCCertificate.generateCertificate({
 *   name: 'my-peer',
 *   expires: Date.now() + (90 * 24 * 60 * 60 * 1000) // 90 days
 * });
 */
class RTCCertificate {
  #certDer: Buffer | null;
  #privateKey: crypto.KeyObject | string;
  #publicKey: crypto.KeyObject | string;
  #expires: number;
  #fingerprints: RTCDtlsFingerprint[] | null;

  /**
   * Create an RTCCertificate instance.
   * Use generateCertificate() static method instead of calling directly.
   * @param certData - Internal certificate data
   * @private
   */
  constructor(certData: CertData) {
    // Store certificate data
    this.#certDer = certData.certDer || null; // Buffer, DER X.509 cert
    this.#privateKey = certData.privateKey; // crypto.KeyObject or PEM string
    this.#publicKey = certData.publicKey;
    this.#expires = certData.expires;

    // Cache fingerprints
    this.#fingerprints = null;
  }

  /**
   * Get the DER-encoded X.509 certificate.
   * Used by the DTLS handshake to transmit the local certificate.
   * @internal
   */
  getCertificateDer(): Buffer | null {
    return this.#certDer;
  }

  /**
   * Get the expiration time.
   * @returns Expiration time in milliseconds since epoch (DOMTimeStamp)
   */
  get expires(): number {
    return this.#expires;
  }

  /**
   * Get the certificate fingerprints.
   * Returns an array of fingerprints for the certificate chain.
   * For self-signed certificates, this returns a single fingerprint.
   *
   * @returns Array of fingerprint objects
   */
  getFingerprints(): RTCDtlsFingerprint[] {
    if (!this.#certDer) {
      throw new Error('Certificate has no DER encoding; cannot compute fingerprint');
    }
    if (!this.#fingerprints) {
      // Fingerprint is computed over the DER certificate (RFC 8122).
      const certDer = this.#certDer;
      const algorithms = ['sha-256', 'sha-384', 'sha-512'];
      this.#fingerprints = algorithms.map(algorithm => ({
        algorithm,
        value: calculateFingerprint(certDer, algorithm),
      }));
    }

    return this.#fingerprints.map(fp => ({ ...fp }));
  }

  /**
   * Get the private key as a Node crypto KeyObject (for the DTLS handshake).
   * @internal
   */
  getPrivateKeyObject(): crypto.KeyObject {
    return this.#toKeyObject(this.#privateKey, 'private');
  }

  /**
   * Coerce a stored key (KeyObject or PEM string) into a KeyObject.
   * @private
   */
  #toKeyObject(
    key: crypto.KeyObject | string,
    kind: 'private' | 'public'
  ): crypto.KeyObject {
    if (key && typeof key === 'object' && key.type) {
      return key; // already a KeyObject
    }
    // At this point the key is a PEM string (or an object lacking a key type).
    return kind === 'private'
      ? crypto.createPrivateKey(key as string)
      : crypto.createPublicKey(key as string);
  }

  /**
   * Get the private key in PEM format.
   * @returns PEM-encoded private key
   * @internal
   */
  getPrivateKey(): string {
    const obj = this.#toKeyObject(this.#privateKey, 'private');
    return obj.export({ type: 'pkcs8', format: 'pem' }) as string;
  }

  /**
   * Get the public key in PEM format.
   * @returns PEM-encoded public key
   * @internal
   */
  getPublicKey(): string {
    const obj = this.#toKeyObject(this.#publicKey, 'public');
    return obj.export({ type: 'spki', format: 'pem' }) as string;
  }

  /**
   * Convert to PEM format (for serialization/storage).
   * The certificate is exported as a PEM-wrapped DER X.509 certificate.
   * @returns Object with pemPrivateKey and pemCertificate
   */
  toPEM(): RTCCertificatePEM {
    const pemCertificate = this.#certDer
      ? `-----BEGIN CERTIFICATE-----\n${this.#certDer
          .toString('base64')
          .match(/.{1,64}/g)!
          .join('\n')}\n-----END CERTIFICATE-----\n`
      : this.getPublicKey();
    return {
      pemPrivateKey: this.getPrivateKey(),
      pemCertificate,
    };
  }

  /**
   * Check if the certificate has expired.
   * @returns True if expired, false otherwise
   */
  isExpired(): boolean {
    return Date.now() > this.#expires;
  }

  /**
   * Generate a new RTCCertificate asynchronously.
   *
   * @param options - Generation options
   * @returns Promise resolving to generated certificate
   *
   * @example
   * const cert = await RTCCertificate.generateCertificate({
   *   name: 'my-app',
   *   expires: Date.now() + (90 * 24 * 60 * 60 * 1000) // 90 days
   * });
   */
  static async generateCertificate(
    options: RTCGenerateCertificateOptions = {}
  ): Promise<RTCCertificate> {
    return new Promise((resolve, reject) => {
      try {
        // Calculate expiration
        let expires: number;
        if (options.expires) {
          expires = options.expires;
        } else {
          const days = options.days || 30;
          expires = Date.now() + (days * 24 * 60 * 60 * 1000);
        }

        // Generate certificate in next tick to avoid blocking
        setImmediate(() => {
          try {
            const certData = generateSelfSignedCertificate({
              name: options.name || 'webrtc',
              days: Math.ceil((expires - Date.now()) / (24 * 60 * 60 * 1000)),
              hash: options.hash || 'sha256'
            });

            certData.expires = expires;
            const certificate = new RTCCertificate(certData);
            resolve(certificate);
          } catch (err) {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Create a certificate from PEM strings.
   *
   * @param pemPrivateKey - PEM-encoded private key
   * @param pemCertificate - PEM-encoded certificate (or public key)
   * @param expires - Expiration time in ms (default: 30 days from now)
   * @returns Certificate instance
   *
   * @example
   * const cert = RTCCertificate.fromPEM(
   *   privateKeyPEM,
   *   publicKeyPEM,
   *   Date.now() + (30 * 24 * 60 * 60 * 1000)
   * );
   */
  static fromPEM(
    pemPrivateKey: string,
    pemCertificate: string,
    expires?: number
  ): RTCCertificate {
    if (typeof pemPrivateKey !== 'string' || pemPrivateKey.length === 0) {
      throw new TypeError('pemPrivateKey must be a non-empty string');
    }

    if (typeof pemCertificate !== 'string' || pemCertificate.length === 0) {
      throw new TypeError('pemCertificate must be a non-empty string');
    }

    // Default expiration to 30 days if not provided
    const expirationTime = expires || (Date.now() + (30 * 24 * 60 * 60 * 1000));

    // If a PEM CERTIFICATE block was provided, recover the DER so fingerprints
    // (computed over the DER cert) round-trip correctly.
    let certDer: Buffer | null = null;
    let publicKey: crypto.KeyObject | string = pemCertificate;
    const certMatch = pemCertificate.match(
      /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/
    );
    if (certMatch) {
      certDer = Buffer.from(certMatch[1]!.replace(/\s/g, ''), 'base64');
      publicKey = crypto.createPublicKey(crypto.createPrivateKey(pemPrivateKey));
    }

    return new RTCCertificate({
      certDer,
      privateKey: pemPrivateKey,
      publicKey,
      expires: expirationTime,
      hash: 'sha256'
    });
  }

  /**
   * Check if key parameters are supported.
   * Currently supports RSA with 1024-4096 bits and ECDSA.
   *
   * @param keyParams - Key parameters
   * @returns True if supported, false otherwise
   */
  static isSupportedKeyParams(keyParams: RTCCertificateKeyParams): boolean {
    if (!keyParams || typeof keyParams !== 'object') {
      return false;
    }

    if (keyParams.type === 'RSA') {
      const modulusLength = keyParams.rsaModulusLength || 2048;
      // Support 1024 to 4096 bits
      return modulusLength >= 1024 && modulusLength <= 4096;
    }

    if (keyParams.type === 'ECDSA') {
      // Support common ECDSA curves
      const curve = keyParams.namedCurve;
      return ['P-256', 'P-384', 'P-521'].includes(curve as string);
    }

    return false;
  }
}

export default RTCCertificate;
export { RTCCertificate };
