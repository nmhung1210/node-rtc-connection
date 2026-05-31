/**
 * @file stun-message.ts
 * @description STUN message codec for ICE connectivity checks (RFC 5389 / 8445).
 * @module ice/stun-message
 *
 * Unlike the server-oriented stun-client.js (binding/allocate), this builds and
 * validates the connectivity-check messages browsers require: USERNAME,
 * MESSAGE-INTEGRITY (HMAC-SHA1 keyed by the peer's ice-pwd), FINGERPRINT
 * (CRC-32 of the message Xored with 0x5354554e), PRIORITY, ICE-CONTROLLING/
 * ICE-CONTROLLED, and USE-CANDIDATE.
 */

'use strict';

import * as crypto from 'crypto';

export const MAGIC_COOKIE = 0x2112a442;

export const METHOD = Object.freeze({ BINDING: 0x0001 });
export const CLASS = Object.freeze({
  REQUEST: 0x000,
  INDICATION: 0x010,
  SUCCESS: 0x100,
  ERROR: 0x110,
});

export const MSG_TYPE = Object.freeze({
  BINDING_REQUEST: 0x0001,
  BINDING_SUCCESS: 0x0101,
  BINDING_ERROR: 0x0111,
});

export const ATTR = Object.freeze({
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  XOR_MAPPED_ADDRESS: 0x0020,
  PRIORITY: 0x0024,
  USE_CANDIDATE: 0x0025,
  FINGERPRINT: 0x8028,
  ICE_CONTROLLED: 0x8029,
  ICE_CONTROLLING: 0x802a,
});

/** A single STUN attribute pending serialization. */
interface StunAttribute {
  type: number;
  value: Buffer;
}

/** Shape of a parsed STUN message. */
export interface ParsedStunMessage {
  type: number;
  transactionId: Buffer;
  attrs: Map<number, Buffer>;
  raw: Buffer;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** CRC-32 (IEEE) for the FINGERPRINT attribute. */
const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @class StunMessageBuilder
 * @description Incrementally builds a STUN message, then appends
 * MESSAGE-INTEGRITY and FINGERPRINT with the correct length pre-computation.
 */
export class StunMessageBuilder {
  type: number;
  transactionId: Buffer;
  attrs: StunAttribute[];

  constructor(type: number, transactionId?: Buffer) {
    this.type = type;
    this.transactionId = transactionId || crypto.randomBytes(12);
    this.attrs = []; // {type, value}
  }

  addAttr(type: number, value: Buffer): this {
    this.attrs.push({ type, value });
    return this;
  }

  addUsername(username: string): this {
    return this.addAttr(ATTR.USERNAME, Buffer.from(username, 'utf8'));
  }

  addPriority(priority: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(priority >>> 0, 0);
    return this.addAttr(ATTR.PRIORITY, b);
  }

  addIceControlling(tieBreaker: Buffer): this {
    return this.addAttr(ATTR.ICE_CONTROLLING, tieBreaker);
  }

  addIceControlled(tieBreaker: Buffer): this {
    return this.addAttr(ATTR.ICE_CONTROLLED, tieBreaker);
  }

  addUseCandidate(): this {
    return this.addAttr(ATTR.USE_CANDIDATE, Buffer.alloc(0));
  }

  addXorMappedAddress(address: string, port: number): this {
    return this.addAttr(ATTR.XOR_MAPPED_ADDRESS, encodeXorAddress(address, port, this.transactionId));
  }

  /** Serialize the attributes added so far. */
  _encodeBody(): Buffer {
    const parts: Buffer[] = [];
    for (const a of this.attrs) {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(a.type, 0);
      head.writeUInt16BE(a.value.length, 2);
      const padded = Buffer.alloc(pad4(a.value.length));
      a.value.copy(padded, 0);
      parts.push(head, padded);
    }
    return Buffer.concat(parts);
  }

  _header(bodyLen: number): Buffer {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(this.type, 0);
    h.writeUInt16BE(bodyLen, 2);
    h.writeUInt32BE(MAGIC_COOKIE, 4);
    this.transactionId.copy(h, 8);
    return h;
  }

  /**
   * Finalize the message, appending MESSAGE-INTEGRITY (keyed by `password`)
   * and FINGERPRINT. Both require the header length to include the attribute
   * being computed, per RFC 5389 §15.4 / §15.5.
   * @param {string} [password] - ICE password for MESSAGE-INTEGRITY
   * @returns {Buffer}
   */
  build(password?: string): Buffer {
    let body = this._encodeBody();

    if (password) {
      // Length for HMAC input = current body + (4 header + 20 HMAC).
      const lenForMI = body.length + 24;
      const header = this._header(lenForMI);
      const hmac = crypto
        .createHmac('sha1', Buffer.from(password, 'utf8'))
        .update(Buffer.concat([header, body]))
        .digest();
      const miHead = Buffer.alloc(4);
      miHead.writeUInt16BE(ATTR.MESSAGE_INTEGRITY, 0);
      miHead.writeUInt16BE(20, 2);
      body = Buffer.concat([body, miHead, hmac]);
    }

    // FINGERPRINT: CRC-32 over the message (with length including fingerprint)
    // Xored with 0x5354554e.
    const lenForFp = body.length + 8;
    const headerFp = this._header(lenForFp);
    const fpVal = (crc32(Buffer.concat([headerFp, body])) ^ 0x5354554e) >>> 0;
    const fpHead = Buffer.alloc(8);
    fpHead.writeUInt16BE(ATTR.FINGERPRINT, 0);
    fpHead.writeUInt16BE(4, 2);
    fpHead.writeUInt32BE(fpVal, 4);
    body = Buffer.concat([body, fpHead]);

    return Buffer.concat([this._header(body.length), body]);
  }
}

/** Encode a XOR-MAPPED-ADDRESS attribute value (IPv4). */
function encodeXorAddress(address: string, port: number, _transactionId: Buffer): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(0, 0);
  buf.writeUInt8(0x01, 1); // family IPv4
  buf.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
  const parts = address.split('.').map(Number);
  const addrInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  buf.writeUInt32BE((addrInt ^ MAGIC_COOKIE) >>> 0, 4);
  return buf;
}

/**
 * Parse a STUN message. Returns null if not a STUN message.
 * @param {Buffer} msg
 * @returns {null|{type:number,transactionId:Buffer,attrs:Map<number,Buffer>,raw:Buffer}}
 */
export function parse(msg: Buffer): ParsedStunMessage | null {
  if (msg.length < 20) return null;
  if (msg.readUInt32BE(4) !== MAGIC_COOKIE) return null;
  const type = msg.readUInt16BE(0);
  const length = msg.readUInt16BE(2);
  if (20 + length > msg.length) return null;
  const transactionId = msg.slice(8, 20);
  const attrs = new Map<number, Buffer>();
  let off = 20;
  const end = 20 + length;
  while (off + 4 <= end) {
    const atype = msg.readUInt16BE(off);
    const alen = msg.readUInt16BE(off + 2);
    off += 4;
    if (off + alen > end) break;
    attrs.set(atype, msg.slice(off, off + alen));
    off += pad4(alen);
  }
  return { type, transactionId, attrs, raw: msg };
}

/**
 * Verify the MESSAGE-INTEGRITY of a parsed message against a password.
 * @param {Buffer} msg - raw message
 * @param {string} password
 * @returns {boolean}
 */
export function verifyIntegrity(msg: Buffer, password: string): boolean {
  // Locate the MESSAGE-INTEGRITY attribute.
  const length = msg.readUInt16BE(2);
  let off = 20;
  const end = 20 + length;
  let miOffset = -1;
  while (off + 4 <= end) {
    const atype = msg.readUInt16BE(off);
    const alen = msg.readUInt16BE(off + 2);
    if (atype === ATTR.MESSAGE_INTEGRITY) {
      miOffset = off;
      break;
    }
    off += 4 + pad4(alen);
  }
  if (miOffset < 0) return false;

  const provided = msg.slice(miOffset + 4, miOffset + 4 + 20);
  // Recompute over header (with length up to & including MI) + body before MI.
  const lenUpToMI = miOffset + 24 - 20;
  const header = Buffer.from(msg.slice(0, 20));
  header.writeUInt16BE(lenUpToMI, 2);
  const hmac = crypto
    .createHmac('sha1', Buffer.from(password, 'utf8'))
    .update(Buffer.concat([header, msg.slice(20, miOffset)]))
    .digest();
  return provided.length === hmac.length && crypto.timingSafeEqual(provided, hmac);
}
