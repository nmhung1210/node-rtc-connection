/**
 * @file crc32c.ts
 * @description CRC-32C (Castagnoli) checksum for SCTP packets (RFC 4960 App. B,
 * polynomial 0x1EDC6F41), reflected input/output, used with the SCTP-specific
 * byte ordering described in RFC 4960 §6.8 / RFC 3309.
 * @module sctp/crc32c
 */

// Precomputed reflected table for polynomial 0x1EDC6F41 (reflected 0x82F63B78).
const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * Compute the raw reflected CRC-32C over a buffer.
 * @returns unsigned 32-bit
 */
export function crc32c(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Insert the SCTP checksum into a packet. The checksum field (bytes 8..11 of
 * the common header) is zeroed, the CRC computed over the whole packet, then
 * written back in little-endian byte order (RFC 4960 §6.8, RFC 3309).
 * @param packet - full SCTP packet (header + chunks)
 * @returns the same packet, checksum filled in
 */
export function applyChecksum(packet: Buffer): Buffer {
  packet.writeUInt32LE(0, 8);
  const crc = crc32c(packet);
  packet.writeUInt32LE(crc, 8);
  return packet;
}

/**
 * Validate the checksum of a received SCTP packet.
 */
export function verifyChecksum(packet: Buffer): boolean {
  const original = packet.readUInt32LE(8);
  packet.writeUInt32LE(0, 8);
  const crc = crc32c(packet);
  packet.writeUInt32LE(original, 8); // restore
  return crc === original;
}
