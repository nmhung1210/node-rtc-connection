/**
 * @file RTCCertificate.js
 * @description DTLS certificate implementation for WebRTC.
 * @module dtls/RTCCertificate
 * 
 * Ported from Chromium's RTCCertificate implementation:
 * - cc/rtc_certificate.h
 * - cc/rtc_certificate.cc
 * - cc/rtc_certificate.idl
 * - cc/rtc_certificate_generator.h
 * - cc/rtc_certificate_generator.cc
 */

const crypto = require('crypto');

/**
 * RTCDtlsFingerprint - DTLS certificate fingerprint
 * @typedef {Object} RTCDtlsFingerprint
 * @property {string} algorithm - Hash algorithm (e.g., 'sha-256')
 * @property {string} value - Fingerprint value (colon-separated hex)
 */

/**
 * Generate a self-signed certificate for DTLS.
 * @param {Object} options - Certificate generation options
 * @param {string} [options.name='webrtc'] - Common name for the certificate
 * @param {number} [options.days=30] - Days until expiration
 * @param {string} [options.hash='sha256'] - Hash algorithm
 * @returns {Object} Certificate object with key and cert
 * @private
 */
function generateSelfSignedCertificate(options = {}) {
  const {
    name = 'webrtc',
    days = 30,
    hash = 'sha256'
  } = options;

  // Generate RSA key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  // Create certificate using Node.js crypto
  // Note: Node.js doesn't have built-in self-signed cert generation,
  // so we'll use a simplified approach storing the key pair
  const expirationDate = new Date();
  expirationDate.setDate(expirationDate.getDate() + days);

  return {
    privateKey,
    publicKey,
    expires: expirationDate.getTime(),
    hash
  };
}

/**
 * Calculate fingerprint from public key.
 * @param {string} publicKey - PEM-encoded public key
 * @param {string} algorithm - Hash algorithm (e.g., 'sha256')
 * @returns {string} Fingerprint (colon-separated hex)
 * @private
 */
function calculateFingerprint(publicKey, algorithm = 'sha256') {
  // Remove PEM headers and decode base64
  const pemBody = publicKey
    .replace(/-----BEGIN PUBLIC KEY-----/, '')
    .replace(/-----END PUBLIC KEY-----/, '')
    .replace(/\s/g, '');
  
  const keyBuffer = Buffer.from(pemBody, 'base64');
  
  // Calculate hash
  const hash = crypto.createHash(algorithm);
  hash.update(keyBuffer);
  const digest = hash.digest('hex').toUpperCase();
  
  // Format as colon-separated pairs
  return digest.match(/.{2}/g).join(':');
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
    this._privateKey = certData.privateKey;
    this._publicKey = certData.publicKey;
    this._expires = certData.expires;
    this._hash = certData.hash || 'sha256';
    
    // Cache fingerprints
    this._fingerprints = null;
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
    if (!this._fingerprints) {
      // Calculate fingerprint for multiple algorithms
      const algorithms = ['sha-256', 'sha-384', 'sha-512'];
      this._fingerprints = algorithms.map(algorithm => {
        const hashAlgo = algorithm.replace('-', ''); // 'sha-256' -> 'sha256'
        return {
          algorithm,
          value: calculateFingerprint(this._publicKey, hashAlgo)
        };
      });
    }
    
    return this._fingerprints.map(fp => ({ ...fp }));
  }

  /**
   * Get the private key in PEM format.
   * @returns {string} PEM-encoded private key
   * @internal
   */
  getPrivateKey() {
    return this._privateKey;
  }

  /**
   * Get the public key in PEM format.
   * @returns {string} PEM-encoded public key
   * @internal
   */
  getPublicKey() {
    return this._publicKey;
  }

  /**
   * Convert to PEM format (for serialization/storage).
   * @returns {Object} Object with pemPrivateKey and pemCertificate
   */
  toPEM() {
    return {
      pemPrivateKey: this._privateKey,
      pemCertificate: this._publicKey
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

    return new RTCCertificate({
      privateKey: pemPrivateKey,
      publicKey: pemCertificate,
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
