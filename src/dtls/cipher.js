/**
 * @file cipher.js
 * @description AEAD record protection for DTLS 1.2 with AES-128-GCM.
 * @module dtls/cipher
 *
 * Implements key derivation and the GCM record encrypt/decrypt for the suite
 * TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 (RFC 5288 / RFC 6347).
 *
 * Key block layout for AEAD (no MAC keys):
 *   client_write_key[16] | server_write_key[16] |
 *   client_write_IV[4]   | server_write_IV[4]      (implicit salt)
 *
 * GCM nonce  = write_IV (4) || explicit_nonce (8)
 * Record     = explicit_nonce (8) || ciphertext || tag (16)
 * AAD (DTLS) = seq_num (8 = epoch||seq) || type (1) || version (2) || plaintext_len (2)
 */

'use strict';

const crypto = require('crypto');
const { prf } = require('./prf');

const KEY_LEN = 16;
const FIXED_IV_LEN = 4;
const RECORD_IV_LEN = 8;
const TAG_LEN = 16;

/**
 * Derive the master secret from the pre-master secret (RFC 5246 §8.1).
 * @param {Buffer} preMasterSecret
 * @param {Buffer} clientRandom - 32 bytes
 * @param {Buffer} serverRandom - 32 bytes
 * @returns {Buffer} 48-byte master secret
 */
function deriveMasterSecret(preMasterSecret, clientRandom, serverRandom) {
  return prf(preMasterSecret, 'master secret', Buffer.concat([clientRandom, serverRandom]), 48);
}

/**
 * Derive the extended master secret (RFC 7627) using the handshake hash.
 * @param {Buffer} preMasterSecret
 * @param {Buffer} sessionHash - hash of handshake messages through CKE
 * @returns {Buffer} 48-byte master secret
 */
function deriveExtendedMasterSecret(preMasterSecret, sessionHash) {
  return prf(preMasterSecret, 'extended master secret', sessionHash, 48);
}

/**
 * Expand the key block and split it into per-direction keys/IVs.
 * @param {Buffer} masterSecret
 * @param {Buffer} clientRandom
 * @param {Buffer} serverRandom
 * @returns {{clientKey:Buffer,serverKey:Buffer,clientIV:Buffer,serverIV:Buffer}}
 */
function deriveKeys(masterSecret, clientRandom, serverRandom) {
  // Note the order: key_expansion uses server_random || client_random.
  const seed = Buffer.concat([serverRandom, clientRandom]);
  const need = 2 * KEY_LEN + 2 * FIXED_IV_LEN;
  const block = prf(masterSecret, 'key expansion', seed, need);

  let o = 0;
  const clientKey = block.slice(o, (o += KEY_LEN));
  const serverKey = block.slice(o, (o += KEY_LEN));
  const clientIV = block.slice(o, (o += FIXED_IV_LEN));
  const serverIV = block.slice(o, (o += FIXED_IV_LEN));
  return { clientKey, serverKey, clientIV, serverIV };
}

/**
 * Build the DTLS GCM additional authenticated data.
 * @param {number} epoch
 * @param {number} seq - 48-bit record sequence
 * @param {number} type - content type
 * @param {number} version - record version (0xFEFD)
 * @param {number} plaintextLen
 * @returns {Buffer}
 */
function buildAAD(epoch, seq, type, version, plaintextLen) {
  const aad = Buffer.alloc(13);
  aad.writeUInt16BE(epoch, 0);
  aad.writeUIntBE(seq, 2, 6);
  aad.writeUInt8(type, 8);
  aad.writeUInt16BE(version, 9);
  aad.writeUInt16BE(plaintextLen, 11);
  return aad;
}

/**
 * @class GcmCipher
 * @description Holds the key/IV for one direction and does record AEAD.
 */
class GcmCipher {
  /**
   * @param {Buffer} key - 16-byte AES key
   * @param {Buffer} fixedIv - 4-byte implicit salt
   */
  constructor(key, fixedIv) {
    this._key = key;
    this._fixedIv = fixedIv;
  }

  /**
   * Encrypt a record fragment.
   * @param {number} epoch
   * @param {number} seq
   * @param {number} type
   * @param {number} version
   * @param {Buffer} plaintext
   * @returns {Buffer} explicit_nonce || ciphertext || tag
   */
  encrypt(epoch, seq, type, version, plaintext) {
    // Explicit nonce: the 64-bit (epoch||seq) record number, unique per record.
    const explicitNonce = Buffer.alloc(RECORD_IV_LEN);
    explicitNonce.writeUInt16BE(epoch, 0);
    explicitNonce.writeUIntBE(seq, 2, 6);

    const nonce = Buffer.concat([this._fixedIv, explicitNonce]);
    const aad = buildAAD(epoch, seq, type, version, plaintext.length);

    const cipher = crypto.createCipheriv('aes-128-gcm', this._key, nonce);
    cipher.setAAD(aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([explicitNonce, ct, tag]);
  }

  /**
   * Decrypt a record fragment.
   * @param {number} epoch
   * @param {number} seq
   * @param {number} type
   * @param {number} version
   * @param {Buffer} record - explicit_nonce || ciphertext || tag
   * @returns {Buffer} plaintext
   * @throws on authentication failure
   */
  decrypt(epoch, seq, type, version, record) {
    const explicitNonce = record.slice(0, RECORD_IV_LEN);
    const tag = record.slice(record.length - TAG_LEN);
    const ct = record.slice(RECORD_IV_LEN, record.length - TAG_LEN);

    const nonce = Buffer.concat([this._fixedIv, explicitNonce]);
    const aad = buildAAD(epoch, seq, type, version, ct.length);

    const decipher = crypto.createDecipheriv('aes-128-gcm', this._key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

module.exports = {
  deriveMasterSecret,
  deriveExtendedMasterSecret,
  deriveKeys,
  GcmCipher,
};
