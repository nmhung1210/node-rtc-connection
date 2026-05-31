/**
 * @file RTCCertificate.js
 * @description DTLS certificate implementation for WebRTC.
 * @module dtls/RTCCertificate
 *
 * Implements the W3C RTCCertificate interface
 * (https://www.w3.org/TR/webrtc/#rtccertificate-interface). Certificate and key
 * generation are handled by src/crypto/x509.js.
 */

const crypto = require('crypto');
const x509 = require('../crypto/x509');

/**
 * RTCDtlsFingerprint - DTLS certificate fingerprint
 * @typedef {Object} RTCDtlsFingerprint
 * @property {string} algorithm - Hash algorithm (e.g., 'sha-256')
 * @property {string} value - Fingerprint value (colon-separated hex)
 */

/**
 * Generate a self-signed X.509 certificate for DTLS.
 *
 * Unlike a bare key pair, a real certificate is required for browser interop:
 * the DTLS handshake transmits the certificate and the peer validates it
 * against the SDP a=fingerprint (a hash over the DER certificate, RFC 8122).
 *
 * @param {Object} options - Certificate generation options
 * @param {string} [options.name] - Common name for the certificate
 * @param {number} [options.days=30] - Days until expiration
 * @returns {Object} Certificate object with DER cert, keys and expiry
 * @private
 */
function generateSelfSignedCertificate(options = {}) {
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
 * @param {Buffer} certDer - DER-encoded X.509 certificate
 * @param {string} algorithm - SDP hash name (e.g. 'sha-256')
 * @returns {string} Fingerprint (colon-separated hex)
 * @private
 */
function calculateFingerprint(certDer, algorithm = 'sha-256') {
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
  /**
   * Create an RTCCertificate instance.
   * Use generateCertificate() static method instead of calling directly.
   * @param {Object} certData - Internal certificate data
   * @private
   */
  constructor(certData) {
    // Store certificate data
    this._certDer = certData.certDer || null; // Buffer, DER X.509 cert
    this._privateKey = certData.privateKey; // crypto.KeyObject or PEM string
    this._publicKey = certData.publicKey;
    this._expires = certData.expires;
    this._hash = certData.hash || 'sha256';

    // Cache fingerprints
    this._fingerprints = null;
  }

  /**
   * Get the DER-encoded X.509 certificate.
   * Used by the DTLS handshake to transmit the local certificate.
   * @returns {Buffer|null}
   * @internal
   */
  getCertificateDer() {
    return this._certDer;
  }

  /**
   * Get the expiration time.
   * @returns {number} Expiration time in milliseconds since epoch (DOMTimeStamp)
   */
  get expires() {
    return this._expires;
  }

  /**
   * Get the certificate fingerprints.
   * Returns an array of fingerprints for the certificate chain.
   * For self-signed certificates, this returns a single fingerprint.
   * 
   * @returns {Array<RTCDtlsFingerprint>} Array of fingerprint objects
   */
  getFingerprints() {
    if (!this._certDer) {
      throw new Error('Certificate has no DER encoding; cannot compute fingerprint');
    }
    if (!this._fingerprints) {
      // Fingerprint is computed over the DER certificate (RFC 8122).
      const algorithms = ['sha-256', 'sha-384', 'sha-512'];
      this._fingerprints = algorithms.map(algorithm => ({
        algorithm,
        value: calculateFingerprint(this._certDer, algorithm),
      }));
    }

    return this._fingerprints.map(fp => ({ ...fp }));
  }

  /**
   * Get the private key as a Node crypto KeyObject (for the DTLS handshake).
   * @returns {crypto.KeyObject}
   * @internal
   */
  getPrivateKeyObject() {
    return this._toKeyObject(this._privateKey, 'private');
  }

  /**
   * Coerce a stored key (KeyObject or PEM string) into a KeyObject.
   * @param {crypto.KeyObject|string} key
   * @param {'private'|'public'} kind
   * @returns {crypto.KeyObject}
   * @private
   */
  _toKeyObject(key, kind) {
    if (key && typeof key === 'object' && key.type) {
      return key; // already a KeyObject
    }
    return kind === 'private'
      ? crypto.createPrivateKey(key)
      : crypto.createPublicKey(key);
  }

  /**
   * Get the private key in PEM format.
   * @returns {string} PEM-encoded private key
   * @internal
   */
  getPrivateKey() {
    const obj = this._toKeyObject(this._privateKey, 'private');
    return obj.export({ type: 'pkcs8', format: 'pem' });
  }

  /**
   * Get the public key in PEM format.
   * @returns {string} PEM-encoded public key
   * @internal
   */
  getPublicKey() {
    const obj = this._toKeyObject(this._publicKey, 'public');
    return obj.export({ type: 'spki', format: 'pem' });
  }

  /**
   * Convert to PEM format (for serialization/storage).
   * The certificate is exported as a PEM-wrapped DER X.509 certificate.
   * @returns {Object} Object with pemPrivateKey and pemCertificate
   */
  toPEM() {
    const pemCertificate = this._certDer
      ? `-----BEGIN CERTIFICATE-----\n${this._certDer
          .toString('base64')
          .match(/.{1,64}/g)
          .join('\n')}\n-----END CERTIFICATE-----\n`
      : this.getPublicKey();
    return {
      pemPrivateKey: this.getPrivateKey(),
      pemCertificate,
    };
  }

  /**
   * Check if the certificate has expired.
   * @returns {boolean} True if expired, false otherwise
   */
  isExpired() {
    return Date.now() > this._expires;
  }

  /**
   * Generate a new RTCCertificate asynchronously.
   * 
   * @param {Object} [options] - Generation options
   * @param {string} [options.name='webrtc'] - Common name for the certificate
   * @param {number} [options.expires] - Expiration time in ms (default: 30 days from now)
   * @param {string} [options.hash='sha256'] - Hash algorithm
   * @returns {Promise<RTCCertificate>} Promise resolving to generated certificate
   * 
   * @example
   * const cert = await RTCCertificate.generateCertificate({
   *   name: 'my-app',
   *   expires: Date.now() + (90 * 24 * 60 * 60 * 1000) // 90 days
   * });
   */
  static async generateCertificate(options = {}) {
    return new Promise((resolve, reject) => {
      try {
        // Calculate expiration
        let expires;
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
   * @param {string} pemPrivateKey - PEM-encoded private key
   * @param {string} pemCertificate - PEM-encoded certificate (or public key)
   * @param {number} [expires] - Expiration time in ms (default: 30 days from now)
   * @returns {RTCCertificate} Certificate instance
   * 
   * @example
   * const cert = RTCCertificate.fromPEM(
   *   privateKeyPEM,
   *   publicKeyPEM,
   *   Date.now() + (30 * 24 * 60 * 60 * 1000)
   * );
   */
  static fromPEM(pemPrivateKey, pemCertificate, expires) {
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
    let certDer = null;
    let publicKey = pemCertificate;
    const certMatch = pemCertificate.match(
      /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/
    );
    if (certMatch) {
      certDer = Buffer.from(certMatch[1].replace(/\s/g, ''), 'base64');
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
   * @param {Object} keyParams - Key parameters
   * @param {string} keyParams.type - Key type ('RSA' or 'ECDSA')
   * @param {number} [keyParams.rsaModulusLength] - RSA key size in bits
   * @param {string} [keyParams.namedCurve] - ECDSA curve name
   * @returns {boolean} True if supported, false otherwise
   */
  static isSupportedKeyParams(keyParams) {
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
      return ['P-256', 'P-384', 'P-521'].includes(curve);
    }

    return false;
  }
}

module.exports = RTCCertificate;
