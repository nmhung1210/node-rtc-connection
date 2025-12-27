const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');
const EventEmitter = require('events');
const RTCDataChannel = require('../src/RTCDataChannel');

class MockNativeChannel extends EventEmitter {
  constructor(label, options = {}) {
    super();
    this.label = label;
    this.ordered = options.ordered !== undefined ? options.ordered : true;
    this.maxPacketLifeTime = options.maxPacketLifeTime || -1;
    this.maxRetransmits = options.maxRetransmits || -1;
    this.protocol = options.protocol || '';
    this.negotiated = options.negotiated || false;
    this.id = options.id !== undefined ? options.id : -1;
    this._state = 0;
  }

  send(data) {
    // Mock send
  }

  close() {
    this._state = 2;
    this.emit('statechange', this._state);
  }
}

describe('RTCDataChannel', () => {
  let nativeChannel;
  let dataChannel;

  beforeEach(() => {
    nativeChannel = new MockNativeChannel('test', { ordered: true });
    dataChannel = new RTCDataChannel(nativeChannel, null);
  });

  describe('constructor', () => {
    it('should initialize with native channel', () => {
      assert.ok(dataChannel);
      assert.strictEqual(dataChannel.label, 'test');
      assert.strictEqual(dataChannel.readyState, 'connecting');
    });
  });

  describe('properties', () => {
    it('should get label from native channel', () => {
      assert.strictEqual(dataChannel.label, 'test');
    });

    it('should get ordered property', () => {
      assert.strictEqual(dataChannel.ordered, true);
    });

    it('should get protocol', () => {
      assert.strictEqual(dataChannel.protocol, '');
    });

    it('should get/set binaryType', () => {
      assert.strictEqual(dataChannel.binaryType, 'arraybuffer');
      dataChannel.binaryType = 'blob';
      assert.strictEqual(dataChannel.binaryType, 'blob');
    });

    it('should throw on invalid binaryType', () => {
      assert.throws(() => {
        dataChannel.binaryType = 'invalid';
      }, /must be either/);
    });

    it('should get/set bufferedAmountLowThreshold', () => {
      dataChannel.bufferedAmountLowThreshold = 1024;
      assert.strictEqual(dataChannel.bufferedAmountLowThreshold, 1024);
    });
  });

  describe('state transitions', () => {
    it('should transition to open', (t, done) => {
      dataChannel.on('open', () => {
        setImmediate(() => {
          assert.strictEqual(dataChannel.readyState, 'open');
          done();
        });
      });
      nativeChannel.emit('statechange', 1); // open
    });

    it('should transition to closing', (t, done) => {
      dataChannel.on('closing', () => {
        setImmediate(() => {
          assert.strictEqual(dataChannel.readyState, 'closing');
          done();
        });
      });
      nativeChannel.emit('statechange', 2); // closing
    });

    it('should transition to closed', (t, done) => {
      dataChannel.on('close', () => {
        setImmediate(() => {
          assert.strictEqual(dataChannel.readyState, 'closed');
          done();
        });
      });
      nativeChannel.emit('statechange', 3); // closed
    });
  });

  describe('send', () => {
    beforeEach(() => {
      nativeChannel.emit('statechange', 1); // open state
    });

    it('should throw when not open', () => {
      const closedChannel = new RTCDataChannel(nativeChannel, null);
      assert.throws(() => {
        closedChannel.send('test');
      }, /not open/);
    });

    it('should send string data', () => {
      let sent = false;
      nativeChannel.send = (data) => {
        sent = true;
        assert.ok(Buffer.isBuffer(data.data));
      };
      dataChannel.send('hello');
      assert.ok(sent);
    });

    it('should send ArrayBuffer', () => {
      const buffer = new ArrayBuffer(10);
      let sent = false;
      nativeChannel.send = (data) => {
        sent = true;
        assert.strictEqual(data.binary, true);
      };
      dataChannel.send(buffer);
      assert.ok(sent);
    });

    it('should throw on message too long', () => {
      const largeBuffer = new ArrayBuffer(70000);
      assert.throws(() => {
        dataChannel.send(largeBuffer);
      }, /too long/);
    });
  });

  describe('message receiving', () => {
    beforeEach(() => {
      nativeChannel.emit('statechange', 1); // open state
    });

    it('should receive text message', (t, done) => {
      dataChannel.on('message', (event) => {
        assert.strictEqual(event.data, 'hello');
        done();
      });
      
      const buffer = Buffer.from('hello', 'utf8');
      nativeChannel.emit('message', { data: buffer, binary: false });
    });

    it('should receive binary message as arraybuffer', (t, done) => {
      dataChannel.binaryType = 'arraybuffer';
      dataChannel.on('message', (event) => {
        assert.ok(event.data instanceof ArrayBuffer);
        done();
      });
      
      const buffer = Buffer.from([1, 2, 3, 4]);
      nativeChannel.emit('message', { data: buffer, binary: true });
    });
  });

  describe('close', () => {
    it('should close the channel', () => {
      dataChannel.close();
      assert.ok(dataChannel._closed);
    });

    it('should not throw when closing twice', () => {
      dataChannel.close();
      dataChannel.close();
      // Should not throw
    });
  });

  describe('events', () => {
    it('should emit bufferedamountlow', (t, done) => {
      dataChannel.bufferedAmountLowThreshold = 100;
      dataChannel.on('bufferedamountlow', () => {
        done();
      });
      
      dataChannel._bufferedAmount = 200;
      nativeChannel.emit('bufferedamountlow', 50);
    });

    it('should emit error', (t, done) => {
      dataChannel.on('error', (err) => {
        assert.ok(err);
        done();
      });
      
      nativeChannel.emit('error', new Error('test error'));
    });
  });
});
