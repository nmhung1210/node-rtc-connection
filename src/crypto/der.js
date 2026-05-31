/**
 * @file der.js
 * @description Minimal ASN.1 DER encoder/decoder for X.509 certificate generation.
 * @module crypto/der
 *
 * Implements just enough of ITU-T X.690 DER to build and read the structures
 * WebRTC needs: self-signed ECDSA certificates and SubjectPublicKeyInfo.
 *
 * All encoders return Buffers. The TLV length is always encoded in the
 * minimal (definite, shortest-form) representation required by DER.
 */

'use strict';

// ASN.1 universal tag numbers (class 0, primitive/constructed as noted).
const TAG = Object.freeze({
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30, // constructed
  SET: 0x31, // constructed
});

/**
 * Encode a DER length in definite, shortest form.
 * @param {number} len
 * @returns {Buffer}
 */
function encodeLength(len) {
  if (len < 0x80) {
    return Buffer.from([len]);
  }
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Wrap a body in a TLV with the given tag.
 * @param {number} tag
 * @param {Buffer} body
 * @returns {Buffer}
 */
function tlv(tag, body) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

/**
 * Encode an unsigned big-endian integer (from a Buffer) as a DER INTEGER,
 * adding a leading 0x00 when the high bit is set so it stays positive.
 * @param {Buffer} buf - Big-endian magnitude.
 * @returns {Buffer}
 */
function encodeIntegerFromBuffer(buf) {
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0x00) {
    start++; // strip leading zeros (keep at least one byte)
  }
  let body = buf.slice(start);
  if (body[0] & 0x80) {
    body = Buffer.concat([Buffer.from([0x00]), body]);
  }
  return tlv(TAG.INTEGER, body);
}

/**
 * Encode a small non-negative JS integer as a DER INTEGER.
 * @param {number} value
 * @returns {Buffer}
 */
function encodeInteger(value) {
  if (value === 0) {
    return tlv(TAG.INTEGER, Buffer.from([0x00]));
  }
  const bytes = [];
  let n = value;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0x00);
  }
  return tlv(TAG.INTEGER, Buffer.from(bytes));
}

/**
 * Encode an OBJECT IDENTIFIER from its dotted-decimal string.
 * @param {string} oid - e.g. "1.2.840.10045.2.1"
 * @returns {Buffer}
 */
function encodeOID(oid) {
  const parts = oid.split('.').map(Number);
  if (parts.length < 2) {
    throw new Error(`Invalid OID: ${oid}`);
  }
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    bytes.push(...stack);
  }
  return tlv(TAG.OID, Buffer.from(bytes));
}

/**
 * Encode a BIT STRING with zero unused bits.
 * @param {Buffer} data
 * @returns {Buffer}
 */
function encodeBitString(data) {
  return tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0x00]), data]));
}

/**
 * Encode an OCTET STRING.
 * @param {Buffer} data
 * @returns {Buffer}
 */
function encodeOctetString(data) {
  return tlv(TAG.OCTET_STRING, data);
}

/**
 * Encode a SEQUENCE from already-encoded components.
 * @param {Buffer[]} components
 * @returns {Buffer}
 */
function encodeSequence(components) {
  return tlv(TAG.SEQUENCE, Buffer.concat(components));
}

/**
 * Encode a SET from already-encoded components.
 * @param {Buffer[]} components
 * @returns {Buffer}
 */
function encodeSet(components) {
  return tlv(TAG.SET, Buffer.concat(components));
}

/**
 * Encode NULL.
 * @returns {Buffer}
 */
function encodeNull() {
  return tlv(TAG.NULL, Buffer.alloc(0));
}

/**
 * Encode a UTF8String.
 * @param {string} str
 * @returns {Buffer}
 */
function encodeUTF8String(str) {
  return tlv(TAG.UTF8_STRING, Buffer.from(str, 'utf8'));
}

/**
 * Encode a context-specific [n] explicit wrapper (constructed).
 * @param {number} n - context tag number
 * @param {Buffer} body
 * @returns {Buffer}
 */
function encodeExplicit(n, body) {
  return tlv(0xa0 | n, body);
}

/**
 * Encode an X.509 time. Uses UTCTime for years < 2050, else GeneralizedTime,
 * per RFC 5280 §4.1.2.5.
 * @param {Date} date
 * @returns {Buffer}
 */
function encodeTime(date) {
  const yyyy = date.getUTCFullYear();
  const pad = (v, n = 2) => String(v).padStart(n, '0');
  const mm = pad(date.getUTCMonth() + 1);
  const dd = pad(date.getUTCDate());
  const hh = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const ss = pad(date.getUTCSeconds());
  if (yyyy < 2050) {
    const yy = pad(yyyy % 100);
    return tlv(TAG.UTC_TIME, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
  }
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(`${yyyy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

module.exports = {
  TAG,
  encodeLength,
  tlv,
  encodeInteger,
  encodeIntegerFromBuffer,
  encodeOID,
  encodeBitString,
  encodeOctetString,
  encodeSequence,
  encodeSet,
  encodeNull,
  encodeUTF8String,
  encodeExplicit,
  encodeTime,
};
