/**
 * @file chunks.ts
 * @description SCTP common header and chunk encode/parse (RFC 4960 + RFC 8260
 * for I-DATA is NOT used; classic DATA only). Scoped to the WebRTC profile.
 * @module sctp/chunks
 */

'use strict';

export const CHUNK_TYPE = Object.freeze({
  DATA: 0,
  INIT: 1,
  INIT_ACK: 2,
  SACK: 3,
  HEARTBEAT: 4,
  HEARTBEAT_ACK: 5,
  ABORT: 6,
  SHUTDOWN: 7,
  SHUTDOWN_ACK: 8,
  ERROR: 9,
  COOKIE_ECHO: 10,
  COOKIE_ACK: 11,
  SHUTDOWN_COMPLETE: 14,
  FORWARD_TSN: 192, // 0xC0
});

export const PARAM_TYPE = Object.freeze({
  HEARTBEAT_INFO: 1,
  STATE_COOKIE: 7,
  UNRECOGNIZED_PARAM: 8,
  COOKIE_PRESERVATIVE: 9,
  SUPPORTED_ADDR_TYPES: 11,
  // RFC 8260 / RFC 3758
  FORWARD_TSN_SUPPORTED: 49152, // 0xC000
  SUPPORTED_EXTENSIONS: 32776, // 0x8008
});

// Payload Protocol Identifiers used by WebRTC data channels (RFC 8831).
export const PPID = Object.freeze({
  DCEP: 50,
  STRING: 51,
  BINARY: 53,
  STRING_EMPTY: 56,
  BINARY_EMPTY: 57,
  STRING_PARTIAL: 54, // deprecated
  BINARY_PARTIAL: 52, // deprecated
});

export interface CommonHeader {
  srcPort: number;
  dstPort: number;
  verificationTag: number;
  checksum: number;
}

export interface ParsedChunk {
  type: number;
  flags: number;
  length: number;
  body: Buffer;
}

export interface ParsedParam {
  type: number;
  length: number;
  value: Buffer;
}

export interface InitBodyParams {
  initiateTag: number;
  a_rwnd: number;
  outStreams: number;
  inStreams: number;
  initialTSN: number;
}

export interface ParsedInitBody {
  initiateTag: number;
  a_rwnd: number;
  outStreams: number;
  inStreams: number;
  initialTSN: number;
  params: ParsedParam[];
}

export interface DataBodyParams {
  tsn: number;
  streamId: number;
  streamSeq: number;
  ppid: number;
  userData: Buffer;
  unordered?: boolean;
  beginning?: boolean;
  ending?: boolean;
}

export interface EncodedDataBody {
  flags: number;
  body: Buffer;
}

export interface ParsedDataBody {
  unordered: boolean;
  beginning: boolean;
  ending: boolean;
  tsn: number;
  streamId: number;
  streamSeq: number;
  ppid: number;
  userData: Buffer;
}

export interface SackBodyParams {
  cumulativeTSNAck: number;
  a_rwnd: number;
  gapBlocks?: Array<[number, number]>;
  dupTSNs?: number[];
}

export interface ParsedSackBody {
  cumulativeTSNAck: number;
  a_rwnd: number;
  gapBlocks: Array<[number, number]>;
  dupTSNs: number[];
}

/** Round a length up to the next 4-byte boundary. */
export function pad4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Encode the 12-byte SCTP common header (checksum left as 0; filled by crc32c).
 * @param {number} srcPort
 * @param {number} dstPort
 * @param {number} verificationTag
 * @returns {Buffer}
 */
export function encodeCommonHeader(srcPort: number, dstPort: number, verificationTag: number): Buffer {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(srcPort, 0);
  h.writeUInt16BE(dstPort, 2);
  h.writeUInt32BE(verificationTag >>> 0, 4);
  h.writeUInt32BE(0, 8); // checksum placeholder
  return h;
}

/**
 * Parse the common header.
 * @param {Buffer} packet
 * @returns {{srcPort:number,dstPort:number,verificationTag:number,checksum:number}}
 */
export function parseCommonHeader(packet: Buffer): CommonHeader {
  return {
    srcPort: packet.readUInt16BE(0),
    dstPort: packet.readUInt16BE(2),
    verificationTag: packet.readUInt32BE(4),
    checksum: packet.readUInt32LE(8),
  };
}

/**
 * Wrap a chunk body with the 4-byte chunk header, padded to 4 bytes.
 * @param {number} type
 * @param {number} flags
 * @param {Buffer} body
 * @returns {Buffer}
 */
export function encodeChunk(type: number, flags: number, body: Buffer): Buffer {
  const len = 4 + body.length;
  const out = Buffer.alloc(pad4(len));
  out.writeUInt8(type, 0);
  out.writeUInt8(flags, 1);
  out.writeUInt16BE(len, 2); // length excludes padding
  body.copy(out, 4);
  return out;
}

/**
 * Parse all chunks out of an SCTP packet (after the 12-byte common header).
 * @param {Buffer} packet
 * @returns {Array<{type:number,flags:number,length:number,body:Buffer}>}
 */
export function parseChunks(packet: Buffer): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let off = 12;
  while (off + 4 <= packet.length) {
    const type = packet.readUInt8(off);
    const flags = packet.readUInt8(off + 1);
    const length = packet.readUInt16BE(off + 2);
    if (length < 4 || off + length > packet.length) break;
    const body = packet.slice(off + 4, off + length);
    chunks.push({ type, flags, length, body });
    off += pad4(length);
  }
  return chunks;
}

/**
 * Encode a TLV parameter, padded to 4 bytes.
 * @param {number} type
 * @param {Buffer} value
 * @returns {Buffer}
 */
export function encodeParam(type: number, value: Buffer): Buffer {
  const len = 4 + value.length;
  const out = Buffer.alloc(pad4(len));
  out.writeUInt16BE(type, 0);
  out.writeUInt16BE(len, 2);
  value.copy(out, 4);
  return out;
}

/**
 * Parse TLV parameters from a buffer.
 * @param {Buffer} buf
 * @returns {Array<{type:number,length:number,value:Buffer}>}
 */
export function parseParams(buf: Buffer): ParsedParam[] {
  const params: ParsedParam[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const type = buf.readUInt16BE(off);
    const length = buf.readUInt16BE(off + 2);
    if (length < 4 || off + length > buf.length) break;
    params.push({ type, length, value: buf.slice(off + 4, off + length) });
    off += pad4(length);
  }
  return params;
}

/**
 * Build an INIT or INIT_ACK fixed body (without parameters).
 * @param {Object} p
 * @param {number} p.initiateTag
 * @param {number} p.a_rwnd - advertised receiver window
 * @param {number} p.outStreams
 * @param {number} p.inStreams
 * @param {number} p.initialTSN
 * @returns {Buffer}
 */
export function encodeInitBody({ initiateTag, a_rwnd, outStreams, inStreams, initialTSN }: InitBodyParams): Buffer {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(initiateTag >>> 0, 0);
  b.writeUInt32BE(a_rwnd >>> 0, 4);
  b.writeUInt16BE(outStreams, 8);
  b.writeUInt16BE(inStreams, 10);
  b.writeUInt32BE(initialTSN >>> 0, 12);
  return b;
}

/**
 * Parse an INIT/INIT_ACK body.
 * @param {Buffer} body
 * @returns {{initiateTag:number,a_rwnd:number,outStreams:number,inStreams:number,initialTSN:number,params:Array}}
 */
export function parseInitBody(body: Buffer): ParsedInitBody {
  return {
    initiateTag: body.readUInt32BE(0),
    a_rwnd: body.readUInt32BE(4),
    outStreams: body.readUInt16BE(8),
    inStreams: body.readUInt16BE(10),
    initialTSN: body.readUInt32BE(12),
    params: parseParams(body.slice(16)),
  };
}

/**
 * Encode a DATA chunk body (RFC 4960 §3.3.1).
 * @param {Object} p
 * @param {number} p.tsn
 * @param {number} p.streamId
 * @param {number} p.streamSeq
 * @param {number} p.ppid
 * @param {Buffer} p.userData
 * @returns {{flags:number, body:Buffer}}
 */
export function encodeDataBody({ tsn, streamId, streamSeq, ppid, userData, unordered = false, beginning = true, ending = true }: DataBodyParams): EncodedDataBody {
  const head = Buffer.alloc(12);
  head.writeUInt32BE(tsn >>> 0, 0);
  head.writeUInt16BE(streamId, 4);
  head.writeUInt16BE(streamSeq, 6);
  head.writeUInt32BE(ppid >>> 0, 8);
  let flags = 0;
  if (ending) flags |= 0x01; // E
  if (beginning) flags |= 0x02; // B
  if (unordered) flags |= 0x04; // U
  return { flags, body: Buffer.concat([head, userData]) };
}

/**
 * Parse a DATA chunk body.
 * @param {number} flags
 * @param {Buffer} body
 */
export function parseDataBody(flags: number, body: Buffer): ParsedDataBody {
  return {
    unordered: !!(flags & 0x04),
    beginning: !!(flags & 0x02),
    ending: !!(flags & 0x01),
    tsn: body.readUInt32BE(0),
    streamId: body.readUInt16BE(4),
    streamSeq: body.readUInt16BE(6),
    ppid: body.readUInt32BE(8),
    userData: body.slice(12),
  };
}

/**
 * Encode a SACK chunk body (cumulative ack only, no gap/dup for simplicity but
 * gap blocks supported via params).
 * @param {Object} p
 * @param {number} p.cumulativeTSNAck
 * @param {number} p.a_rwnd
 * @param {Array<[number,number]>} [p.gapBlocks] - [start,end] offsets from cumAck+1
 * @param {Array<number>} [p.dupTSNs]
 * @returns {Buffer}
 */
export function encodeSackBody({ cumulativeTSNAck, a_rwnd, gapBlocks = [], dupTSNs = [] }: SackBodyParams): Buffer {
  const b = Buffer.alloc(12 + gapBlocks.length * 4 + dupTSNs.length * 4);
  b.writeUInt32BE(cumulativeTSNAck >>> 0, 0);
  b.writeUInt32BE(a_rwnd >>> 0, 4);
  b.writeUInt16BE(gapBlocks.length, 8);
  b.writeUInt16BE(dupTSNs.length, 10);
  let o = 12;
  for (const [start, end] of gapBlocks) {
    b.writeUInt16BE(start, o); b.writeUInt16BE(end, o + 2); o += 4;
  }
  for (const d of dupTSNs) { b.writeUInt32BE(d >>> 0, o); o += 4; }
  return b;
}

/**
 * Parse a SACK chunk body.
 */
export function parseSackBody(body: Buffer): ParsedSackBody {
  const cumulativeTSNAck = body.readUInt32BE(0);
  const a_rwnd = body.readUInt32BE(4);
  const numGap = body.readUInt16BE(8);
  const numDup = body.readUInt16BE(10);
  const gapBlocks: Array<[number, number]> = [];
  let o = 12;
  for (let i = 0; i < numGap; i++) {
    gapBlocks.push([body.readUInt16BE(o), body.readUInt16BE(o + 2)]);
    o += 4;
  }
  const dupTSNs: number[] = [];
  for (let i = 0; i < numDup; i++) { dupTSNs.push(body.readUInt32BE(o)); o += 4; }
  return { cumulativeTSNAck, a_rwnd, gapBlocks, dupTSNs };
}
