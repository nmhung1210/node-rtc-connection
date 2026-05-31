/**
 * @file protocol.js
 * @description DTLS 1.2 wire-format constants and TLV/vector encoders.
 * @module dtls/protocol
 *
 * Covers exactly what WebRTC's data channel needs:
 *   cipher suite TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 (0xC02B)
 *   curve secp256r1, signature scheme ecdsa_secp256r1_sha256.
 *
 * References: RFC 6347 (DTLS 1.2), RFC 5246 (TLS 1.2), RFC 8422 (ECC).
 */

'use strict';

// DTLS 1.2 on the wire is version 0xFEFD (i.e. ~1.2).
const DTLS_1_2 = 0xfefd;
const DTLS_1_0 = 0xfeff; // used in some ClientHello/HelloVerifyRequest fields

const CONTENT_TYPE = Object.freeze({
  CHANGE_CIPHER_SPEC: 20,
  ALERT: 21,
  HANDSHAKE: 22,
  APPLICATION_DATA: 23,
});

const HANDSHAKE_TYPE = Object.freeze({
  HELLO_REQUEST: 0,
  CLIENT_HELLO: 1,
  SERVER_HELLO: 2,
  HELLO_VERIFY_REQUEST: 3,
  CERTIFICATE: 11,
  SERVER_KEY_EXCHANGE: 12,
  CERTIFICATE_REQUEST: 13,
  SERVER_HELLO_DONE: 14,
  CERTIFICATE_VERIFY: 15,
  CLIENT_KEY_EXCHANGE: 16,
  FINISHED: 20,
});

const ALERT_LEVEL = Object.freeze({ WARNING: 1, FATAL: 2 });
const ALERT_DESC = Object.freeze({
  CLOSE_NOTIFY: 0,
  HANDSHAKE_FAILURE: 40,
  BAD_CERTIFICATE: 42,
  DECRYPT_ERROR: 51,
  INTERNAL_ERROR: 80,
});

// TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
const CIPHER_SUITE = 0xc02b;

const NAMED_GROUP = Object.freeze({ secp256r1: 0x0017 });
const EC_POINT_FORMAT = Object.freeze({ uncompressed: 0 });

// SignatureAndHashAlgorithm
const HASH_ALG = Object.freeze({ sha256: 4, sha384: 5, sha512: 6 });
const SIG_ALG = Object.freeze({ rsa: 1, ecdsa: 3 });

// ClientCertificateType
const CERT_TYPE = Object.freeze({ ecdsa_sign: 64, rsa_sign: 1 });

const EXTENSION = Object.freeze({
  SUPPORTED_GROUPS: 10,
  EC_POINT_FORMATS: 11,
  SIGNATURE_ALGORITHMS: 13,
  EXTENDED_MASTER_SECRET: 23,
  RENEGOTIATION_INFO: 0xff01,
});

const FINISHED_LABEL = Object.freeze({
  CLIENT: 'client finished',
  SERVER: 'server finished',
});

// ---- Vector / integer encoders -------------------------------------------

/** Encode a uint24 (3 bytes, big-endian). */
function uint24(n) {
  return Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

/** Read a uint24 at offset. */
function readUint24(buf, off) {
  return (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
}

/** Encode a uint48 (6 bytes) from a JS number. */
function uint48(n) {
  const b = Buffer.alloc(6);
  b.writeUIntBE(n, 0, 6);
  return b;
}

/** Length-prefixed vector with a 1-byte length. */
function vec8(body) {
  return Buffer.concat([Buffer.from([body.length]), body]);
}

/** Length-prefixed vector with a 2-byte length. */
function vec16(body) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

/** Length-prefixed vector with a 3-byte length. */
function vec24(body) {
  return Buffer.concat([uint24(body.length), body]);
}

// ---- Record layer ---------------------------------------------------------

/**
 * Encode a DTLS record (13-byte header + fragment).
 * @param {number} type - CONTENT_TYPE
 * @param {number} epoch
 * @param {number} seq - 48-bit sequence number
 * @param {Buffer} fragment
 * @param {number} [version=DTLS_1_2]
 * @returns {Buffer}
 */
function encodeRecord(type, epoch, seq, fragment, version = DTLS_1_2) {
  const header = Buffer.alloc(13);
  header.writeUInt8(type, 0);
  header.writeUInt16BE(version, 1);
  header.writeUInt16BE(epoch, 3);
  header.writeUIntBE(seq, 5, 6);
  header.writeUInt16BE(fragment.length, 11);
  return Buffer.concat([header, fragment]);
}

/**
 * Parse one or more DTLS records from a datagram. Multiple records may be
 * packed into a single UDP packet.
 * @param {Buffer} packet
 * @returns {Array<{type:number,version:number,epoch:number,seq:number,fragment:Buffer}>}
 */
function parseRecords(packet) {
  const records = [];
  let off = 0;
  while (off + 13 <= packet.length) {
    const type = packet.readUInt8(off);
    const version = packet.readUInt16BE(off + 1);
    const epoch = packet.readUInt16BE(off + 3);
    const seq = packet.readUIntBE(off + 5, 6);
    const length = packet.readUInt16BE(off + 11);
    const start = off + 13;
    if (start + length > packet.length) break;
    records.push({ type, version, epoch, seq, fragment: packet.slice(start, start + length) });
    off = start + length;
  }
  return records;
}

// ---- Handshake layer -------------------------------------------------------

/**
 * Encode a DTLS handshake message header + body (unfragmented).
 * @param {number} msgType - HANDSHAKE_TYPE
 * @param {number} messageSeq
 * @param {Buffer} body
 * @returns {Buffer}
 */
function encodeHandshake(msgType, messageSeq, body) {
  const header = Buffer.alloc(12);
  header.writeUInt8(msgType, 0);
  uint24(body.length).copy(header, 1); // length
  header.writeUInt16BE(messageSeq, 4); // message_seq
  uint24(0).copy(header, 6); // fragment_offset
  uint24(body.length).copy(header, 9); // fragment_length
  return Buffer.concat([header, body]);
}

/**
 * Parse a handshake message header.
 * @param {Buffer} buf - starts at the handshake header
 * @returns {{msgType:number,length:number,messageSeq:number,fragmentOffset:number,fragmentLength:number,body:Buffer}}
 */
function parseHandshake(buf) {
  const msgType = buf.readUInt8(0);
  const length = readUint24(buf, 1);
  const messageSeq = buf.readUInt16BE(4);
  const fragmentOffset = readUint24(buf, 6);
  const fragmentLength = readUint24(buf, 9);
  const body = buf.slice(12, 12 + fragmentLength);
  return { msgType, length, messageSeq, fragmentOffset, fragmentLength, body };
}

module.exports = {
  DTLS_1_2,
  DTLS_1_0,
  CONTENT_TYPE,
  HANDSHAKE_TYPE,
  ALERT_LEVEL,
  ALERT_DESC,
  CIPHER_SUITE,
  NAMED_GROUP,
  EC_POINT_FORMAT,
  HASH_ALG,
  SIG_ALG,
  CERT_TYPE,
  EXTENSION,
  FINISHED_LABEL,
  uint24,
  readUint24,
  uint48,
  vec8,
  vec16,
  vec24,
  encodeRecord,
  parseRecords,
  encodeHandshake,
  parseHandshake,
};
