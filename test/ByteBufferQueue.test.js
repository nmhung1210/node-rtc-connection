/**
 * Test suite for ByteBufferQueue
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const ByteBufferQueue = require('../src/foundation/ByteBufferQueue');

describe('ByteBufferQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new ByteBufferQueue();
  });

  describe('construction', () => {
    it('should initialize with size 0', () => {
      assert.strictEqual(queue.size, 0);
      assert.strictEqual(queue.empty, true);
    });
  });

  describe('append', () => {
    it('should append a single buffer', () => {
      const buffer = Buffer.from([1, 2, 3]);
      queue.append(buffer);
      assert.strictEqual(queue.size, 3);
      assert.strictEqual(queue.empty, false);
    });

    it('should append multiple buffers', () => {
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.from([3, 4, 5]));
      queue.append(Buffer.from([6]));
      assert.strictEqual(queue.size, 6);
    });

    it('should ignore empty buffers', () => {
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.alloc(0));
      assert.strictEqual(queue.size, 2);
    });

    it('should throw if argument is not a Buffer', () => {
      assert.throws(() => queue.append('not a buffer'), TypeError);
      assert.throws(() => queue.append([1, 2, 3]), TypeError);
    });
  });

  describe('readInto', () => {
    it('should read from a single buffer', () => {
      queue.append(Buffer.from([1, 2, 3, 4, 5]));
      const out = Buffer.alloc(3);
      const bytesRead = queue.readInto(out);
      
      assert.strictEqual(bytesRead, 3);
      assert.deepStrictEqual(out, Buffer.from([1, 2, 3]));
      assert.strictEqual(queue.size, 2);
    });

    it('should read across buffer boundaries', () => {
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.from([3, 4, 5]));
      queue.append(Buffer.from([6, 7, 8]));
      
      const out = Buffer.alloc(5);
      const bytesRead = queue.readInto(out);
      
      assert.strictEqual(bytesRead, 5);
      assert.deepStrictEqual(out, Buffer.from([1, 2, 3, 4, 5]));
      assert.strictEqual(queue.size, 3);
    });

    it('should handle partial buffer consumption', () => {
      queue.append(Buffer.from([1, 2, 3, 4, 5]));
      
      let out = Buffer.alloc(2);
      queue.readInto(out);
      assert.deepStrictEqual(out, Buffer.from([1, 2]));
      assert.strictEqual(queue.size, 3);
      
      out = Buffer.alloc(2);
      queue.readInto(out);
      assert.deepStrictEqual(out, Buffer.from([3, 4]));
      assert.strictEqual(queue.size, 1);
      
      out = Buffer.alloc(2);
      const bytesRead = queue.readInto(out);
      assert.strictEqual(bytesRead, 1);
      assert.strictEqual(out[0], 5);
      assert.strictEqual(queue.empty, true);
    });

    it('should return 0 when queue is empty', () => {
      const out = Buffer.alloc(10);
      const bytesRead = queue.readInto(out);
      assert.strictEqual(bytesRead, 0);
    });

    it('should read less than requested if not enough data', () => {
      queue.append(Buffer.from([1, 2, 3]));
      const out = Buffer.alloc(10);
      const bytesRead = queue.readInto(out);
      
      assert.strictEqual(bytesRead, 3);
      assert.strictEqual(out[0], 1);
      assert.strictEqual(out[1], 2);
      assert.strictEqual(out[2], 3);
    });

    it('should throw if argument is not a Buffer', () => {
      assert.throws(() => queue.readInto('not a buffer'), TypeError);
    });
  });

  describe('read', () => {
    it('should read and return exact number of bytes', () => {
      queue.append(Buffer.from([1, 2, 3, 4, 5]));
      const data = queue.read(3);
      
      assert.deepStrictEqual(data, Buffer.from([1, 2, 3]));
      assert.strictEqual(queue.size, 2);
    });

    it('should throw if not enough bytes available', () => {
      queue.append(Buffer.from([1, 2, 3]));
      assert.throws(() => queue.read(5), RangeError);
    });

    it('should work across buffer boundaries', () => {
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.from([3, 4]));
      queue.append(Buffer.from([5, 6]));
      
      const data = queue.read(4);
      assert.deepStrictEqual(data, Buffer.from([1, 2, 3, 4]));
      assert.strictEqual(queue.size, 2);
    });
  });

  describe('peek', () => {
    it('should peek without consuming data', () => {
      queue.append(Buffer.from([1, 2, 3, 4, 5]));
      
      const peeked = queue.peek(3);
      assert.deepStrictEqual(peeked, Buffer.from([1, 2, 3]));
      assert.strictEqual(queue.size, 5); // Size unchanged
      
      const read = queue.read(3);
      assert.deepStrictEqual(read, Buffer.from([1, 2, 3]));
    });

    it('should peek all data by default', () => {
      queue.append(Buffer.from([1, 2, 3]));
      queue.append(Buffer.from([4, 5]));
      
      const peeked = queue.peek();
      assert.deepStrictEqual(peeked, Buffer.from([1, 2, 3, 4, 5]));
      assert.strictEqual(queue.size, 5);
    });

    it('should peek across buffer boundaries', () => {
      queue.append(Buffer.from([1, 2]));
      queue.append(Buffer.from([3, 4]));
      queue.append(Buffer.from([5, 6]));
      
      const peeked = queue.peek(4);
      assert.deepStrictEqual(peeked, Buffer.from([1, 2, 3, 4]));
      assert.strictEqual(queue.size, 6);
    });

    it('should return empty buffer for empty queue', () => {
      const peeked = queue.peek();
      assert.strictEqual(peeked.length, 0);
    });
  });

  describe('clear', () => {
    it('should clear all buffers', () => {
      queue.append(Buffer.from([1, 2, 3]));
      queue.append(Buffer.from([4, 5, 6]));
      assert.strictEqual(queue.size, 6);
      
      queue.clear();
      
      assert.strictEqual(queue.size, 0);
      assert.strictEqual(queue.empty, true);
    });

    it('should handle partial buffer consumption before clear', () => {
      queue.append(Buffer.from([1, 2, 3, 4, 5]));
      queue.read(2);
      assert.strictEqual(queue.size, 3);
      
      queue.clear();
      
      assert.strictEqual(queue.size, 0);
      assert.strictEqual(queue.empty, true);
    });
  });

  describe('complex scenarios', () => {
    it('should handle interleaved append and read operations', () => {
      queue.append(Buffer.from([1, 2]));
      assert.strictEqual(queue.read(1)[0], 1);
      
      queue.append(Buffer.from([3, 4, 5]));
      assert.deepStrictEqual(queue.read(3), Buffer.from([2, 3, 4]));
      
      queue.append(Buffer.from([6]));
      assert.deepStrictEqual(queue.read(2), Buffer.from([5, 6]));
      
      assert.strictEqual(queue.empty, true);
    });

    it('should handle large data sets', () => {
      const chunkSize = 1000;
      const numChunks = 100;
      
      for (let i = 0; i < numChunks; i++) {
        const chunk = Buffer.alloc(chunkSize, i % 256);
        queue.append(chunk);
      }
      
      assert.strictEqual(queue.size, chunkSize * numChunks);
      
      const allData = queue.read(chunkSize * numChunks);
      assert.strictEqual(allData.length, chunkSize * numChunks);
      assert.strictEqual(queue.empty, true);
    });
  });
});
