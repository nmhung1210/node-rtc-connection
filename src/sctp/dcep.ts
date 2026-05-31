/**
 * @file dcep.ts
 * @description Data Channel Establishment Protocol (RFC 8832) message codec.
 * @module sctp/dcep
 *
 * DCEP runs on PPID 50 and negotiates a data channel on an SCTP stream:
 *   DATA_CHANNEL_OPEN (0x03)  -> DATA_CHANNEL_ACK (0x02)
 */

'use strict';

export const MESSAGE_TYPE = Object.freeze({
  DATA_CHANNEL_ACK: 0x02,
  DATA_CHANNEL_OPEN: 0x03,
});

// Channel types (reliability/ordering), RFC 8832 §5.1.
export const CHANNEL_TYPE = Object.freeze({
  RELIABLE: 0x00,
  RELIABLE_UNORDERED: 0x80,
  PARTIAL_RELIABLE_REXMIT: 0x01,
  PARTIAL_RELIABLE_REXMIT_UNORDERED: 0x81,
  PARTIAL_RELIABLE_TIMED: 0x02,
  PARTIAL_RELIABLE_TIMED_UNORDERED: 0x82,
});

export interface OpenParams {
  channelType: number;
  priority?: number;
  reliabilityParameter?: number;
  label?: string;
  protocol?: string;
}

export interface DecodedOpen {
  channelType: number;
  priority: number;
  reliabilityParameter: number;
  label: string;
  protocol: string;
  unordered: boolean;
}

/**
 * Encode a DATA_CHANNEL_OPEN message.
 * @param {Object} p
 * @param {number} p.channelType
 * @param {number} p.priority
 * @param {number} p.reliabilityParameter
 * @param {string} p.label
 * @param {string} p.protocol
 * @returns {Buffer}
 */
export function encodeOpen({ channelType, priority = 0, reliabilityParameter = 0, label = '', protocol = '' }: OpenParams): Buffer {
  const labelBuf = Buffer.from(label, 'utf8');
  const protoBuf = Buffer.from(protocol, 'utf8');
  const buf = Buffer.alloc(12 + labelBuf.length + protoBuf.length);
  buf.writeUInt8(MESSAGE_TYPE.DATA_CHANNEL_OPEN, 0);
  buf.writeUInt8(channelType, 1);
  buf.writeUInt16BE(priority, 2);
  buf.writeUInt32BE(reliabilityParameter >>> 0, 4);
  buf.writeUInt16BE(labelBuf.length, 8);
  buf.writeUInt16BE(protoBuf.length, 10);
  labelBuf.copy(buf, 12);
  protoBuf.copy(buf, 12 + labelBuf.length);
  return buf;
}

/**
 * Decode a DATA_CHANNEL_OPEN message.
 * @param {Buffer} buf
 * @returns {Object}
 */
export function decodeOpen(buf: Buffer): DecodedOpen {
  const channelType = buf.readUInt8(1);
  const priority = buf.readUInt16BE(2);
  const reliabilityParameter = buf.readUInt32BE(4);
  const labelLen = buf.readUInt16BE(8);
  const protoLen = buf.readUInt16BE(10);
  const label = buf.slice(12, 12 + labelLen).toString('utf8');
  const protocol = buf.slice(12 + labelLen, 12 + labelLen + protoLen).toString('utf8');
  const unordered = (channelType & 0x80) !== 0;
  return { channelType, priority, reliabilityParameter, label, protocol, unordered };
}

/** Encode a DATA_CHANNEL_ACK message. */
export function encodeAck(): Buffer {
  return Buffer.from([MESSAGE_TYPE.DATA_CHANNEL_ACK]);
}

/** Return the message type of a DCEP buffer. */
export function messageType(buf: Buffer): number {
  return buf.length > 0 ? buf.readUInt8(0) : -1;
}
