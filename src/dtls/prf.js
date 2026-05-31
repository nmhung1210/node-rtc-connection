/**
 * @file prf.js
 * @description TLS 1.2 pseudo-random function (RFC 5246 §5) with SHA-256.
 * @module dtls/prf
 *
 * The cipher suite TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 uses P_SHA256 for
 * the PRF. This module also exposes the underlying HMAC-based P_hash.
 */

'use strict';

const crypto = require('crypto');

/**
 * P_hash(secret, seed) expanded to `length` bytes (RFC 5246 §5).
 *   A(0) = seed
 *   A(i) = HMAC(secret, A(i-1))
 *   P_hash = HMAC(secret, A(1)+seed) | HMAC(secret, A(2)+seed) | ...
 *
 * @param {string} hashAlg - Node hash name, e.g. 'sha256'.
 * @param {Buffer} secret
 * @param {Buffer} seed
 * @param {number} length
 * @returns {Buffer}
 */
function pHash(hashAlg, secret, seed, length) {
  const out = [];
  let total = 0;
  let a = seed; // A(0)
  while (total < length) {
    a = crypto.createHmac(hashAlg, secret).update(a).digest(); // A(i)
    const chunk = crypto
      .createHmac(hashAlg, secret)
      .update(Buffer.concat([a, seed]))
      .digest();
    out.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(out).slice(0, length);
}

/**
 * TLS 1.2 PRF = P_SHA256(secret, label + seed).
 *
 * @param {Buffer} secret
 * @param {string} label - ASCII label, e.g. "master secret".
 * @param {Buffer} seed
 * @param {number} length
 * @returns {Buffer}
 */
function prf(secret, label, seed, length) {
  const labelAndSeed = Buffer.concat([Buffer.from(label, 'ascii'), seed]);
  return pHash('sha256', secret, labelAndSeed, length);
}

module.exports = { prf, pHash };
