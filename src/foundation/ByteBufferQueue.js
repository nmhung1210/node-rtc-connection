/**
 * @fileoverview ByteBufferQueue - Efficient byte buffer with O(1) append and O(n) read.
 * 
 * Ported from Chromium's WebRTC implementation:
 * chromium/src/third_party/blink/renderer/modules/peerconnection/byte_buffer_queue.{h,cc}
 * 
 * This class provides efficient management of byte buffers with O(1) append operations
 * and O(n) read operations. Clients can append entire buffers then copy data out across
 * buffer boundaries.
 * 
 * @license BSD-3-Clause
 * @author nmhung1210
 */

'use strict';

/**
 * A ByteBufferQueue manages a queue of byte buffers with efficient operations.
 * 
 * Invariants maintained:
 * - size_ = sum of all buffer sizes - frontBufferOffset_
 * - No buffer in the queue is empty
 * - If queue is empty, frontBufferOffset_ = 0
 * - Otherwise, frontBufferOffset_ < front buffer size
 */
class ByteBufferQueue {
  constructor() {
    /**
     * Total number of bytes available to read.
     * @private {number}
     */
    this._size = 0;

    /**
     * Double-ended queue of byte buffers.
     * Append() pushes to the back, ReadInto() consumes from the front.
     * @private {Buffer[]}
     */
    this._buffers = [];

    /**
     * Offset from which to start reading the front buffer.
     * @private {number}
     */
    this._frontBufferOffset = 0;
  }

  /**
   * Number of bytes that can be read.
   * @returns {number}
   */
  get size() {
    return this._size;
  }

  /**
   * Returns true if no bytes are available to read.
   * @returns {boolean}
   */
  get empty() {
    return this._size === 0;
  }

  /**
   * Copies data into the given buffer. Consumes bytes from the queue.
   * Returns the number of bytes written to bufferOut.
   * 
   * @param {Buffer} bufferOut - Destination buffer to read into
   * @returns {number} Number of bytes actually read
   * @throws {TypeError} If bufferOut is not a Buffer
   */
  readInto(bufferOut) {
    if (!Buffer.isBuffer(bufferOut)) {
      throw new TypeError('bufferOut must be a Buffer');
    }

    let readAmount = 0;
    let outputOffset = 0;

    while (outputOffset < bufferOut.length && this._buffers.length > 0) {
      const frontBuffer = this._buffers[0];
      const availableInFront = frontBuffer.length - this._frontBufferOffset;
      const remainingOutput = bufferOut.length - outputOffset;
      const toCopy = Math.min(availableInFront, remainingOutput);

      // Copy data from front buffer to output
      frontBuffer.copy(
        bufferOut,
        outputOffset,
        this._frontBufferOffset,
        this._frontBufferOffset + toCopy
      );

      readAmount += toCopy;
      outputOffset += toCopy;

      if (toCopy < availableInFront) {
        // Partial read, update offset
        this._frontBufferOffset += toCopy;
      } else {
        // Consumed entire front buffer, remove it
        this._buffers.shift();
        this._frontBufferOffset = 0;
      }
    }

    this._size -= readAmount;
    this._checkInvariants();
    return readAmount;
  }

  /**
   * Appends a buffer to the queue. Takes ownership of the buffer.
   * Empty buffers are ignored.
   * 
   * @param {Buffer} buffer - Buffer to append
   * @throws {TypeError} If buffer is not a Buffer
   */
  append(buffer) {
    if (!Buffer.isBuffer(buffer)) {
      throw new TypeError('buffer must be a Buffer');
    }

    if (buffer.length === 0) {
      return; // Ignore empty buffers
    }

    this._size += buffer.length;
    this._buffers.push(buffer);
    this._checkInvariants();
  }

  /**
   * Clears all stored buffers.
   */
  clear() {
    this._buffers = [];
    this._frontBufferOffset = 0;
    this._size = 0;
    this._checkInvariants();
  }

  /**
   * Reads and consumes exactly n bytes.
   * 
   * @param {number} n - Number of bytes to read
   * @returns {Buffer} Buffer containing exactly n bytes
   * @throws {RangeError} If fewer than n bytes are available
   */
  read(n) {
    if (n > this._size) {
      throw new RangeError(`Cannot read ${n} bytes, only ${this._size} available`);
    }
    if (n === 0) {
      return Buffer.allocUnsafe(0);
    }

    const result = Buffer.allocUnsafe(n);
    const bytesRead = this.readInto(result);

    if (bytesRead !== n) {
      throw new Error(`Internal error: read ${bytesRead} bytes, expected ${n}`);
    }

    return result;
  }

  /**
   * Peeks at data without consuming it.
   * 
   * @param {number} [n=this._size] - Number of bytes to peek
   * @returns {Buffer} Buffer containing up to n bytes (not consumed)
   */
  peek(n = this._size) {
    const peekAmount = Math.min(n, this._size);
    if (peekAmount === 0) {
      return Buffer.allocUnsafe(0);
    }

    const result = Buffer.allocUnsafe(peekAmount);
    let written = 0;
    let bufferIndex = 0;
    let offset = this._frontBufferOffset;

    while (written < peekAmount && bufferIndex < this._buffers.length) {
      const buffer = this._buffers[bufferIndex];
      const available = buffer.length - offset;
      const toCopy = Math.min(available, peekAmount - written);

      buffer.copy(result, written, offset, offset + toCopy);
      written += toCopy;

      bufferIndex++;
      offset = 0; // Reset offset for subsequent buffers
    }

    return result;
  }

  /**
   * Checks internal invariants (development mode only).
   * @private
   * @throws {Error} If invariants are violated
   */
  _checkInvariants() {
    if (process.env.NODE_ENV !== 'production') {
      let bufferSizeSum = 0;
      for (const buffer of this._buffers) {
        if (buffer.length === 0) {
          throw new Error('Invariant violation: empty buffer in queue');
        }
        bufferSizeSum += buffer.length;
      }

      const expectedSize = bufferSizeSum - this._frontBufferOffset;
      if (this._size !== expectedSize) {
        throw new Error(
          `Invariant violation: size=${this._size}, expected=${expectedSize}`
        );
      }

      if (this._buffers.length === 0) {
        if (this._frontBufferOffset !== 0) {
          throw new Error('Invariant violation: offset non-zero with empty queue');
        }
      } else {
        if (this._frontBufferOffset >= this._buffers[0].length) {
          throw new Error('Invariant violation: offset >= front buffer size');
        }
      }
    }
  }
}

module.exports = ByteBufferQueue;
