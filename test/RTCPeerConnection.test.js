const assert = require('assert');
const { describe, it, beforeEach } = require('node:test');
const EventEmitter = require('events');
const RTCPeerConnection = require('../src/RTCPeerConnection');
const RTCSessionDescription = require('../src/RTCSessionDescription');

class MockNativePeerConnection extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
  }

  async createOffer() {
    return { type: 'offer', sdp: 'mock sdp offer' };
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock sdp answer' };
  }

  async setLocalDescription(desc) {
    this.localDescription = desc;
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  async addIceCandidate(candidate) {
    // Mock
  }

  createDataChannel(label, options) {
    const channel = new EventEmitter();
    channel.label = label;
    channel.send = () => {};
    channel.close = () => {};
    return channel;
  }

  setConfiguration(config) {
    this.config = config;
  }

  async getStats() {
    return {};
  }

  close() {
    this.emit('close');
  }

  removeAllListeners() {
    super.removeAllListeners();
  }
}

class MockFactory {
  createPeerConnection(config) {
    return new MockNativePeerConnection(config);
  }
}

describe('RTCPeerConnection', () => {
  let factory;
  let pc;

  beforeEach(() => {
    factory = new MockFactory();
    pc = new RTCPeerConnection({}, factory);
  });

  describe('constructor', () => {
    it('should create with configuration', () => {
      const config = {
        iceServers: [{ urls: 'stun:stun.example.com' }]
      };
      const pc = new RTCPeerConnection(config, factory);
      assert.ok(pc);
      assert.strictEqual(pc.signalingState, 'stable');
    });

    it('should initialize states', () => {
      assert.strictEqual(pc.signalingState, 'stable');
      assert.strictEqual(pc.iceGatheringState, 'new');
      assert.strictEqual(pc.iceConnectionState, 'new');
      assert.strictEqual(pc.connectionState, 'new');
    });
  });

  describe('configuration', () => {
    it('should parse ice servers', () => {
      const config = {
        iceServers: [
          { urls: 'stun:stun.example.com' },
          { urls: ['turn:turn1.com', 'turn:turn2.com'], username: 'user', credential: 'pass' }
        ]
      };
      const pc = new RTCPeerConnection(config, factory);
      const result = pc.getConfiguration();
      assert.strictEqual(result.iceServers.length, 2);
      assert.ok(Array.isArray(result.iceServers[0].urls));
    });

    it('should set configuration', () => {
      const newConfig = {
        iceServers: [{ urls: 'stun:new.example.com' }]
      };
      pc.setConfiguration(newConfig);
      const result = pc.getConfiguration();
      assert.strictEqual(result.iceServers[0].urls[0], 'stun:new.example.com');
    });
  });

  describe('createOffer', () => {
    it('should create an offer', async () => {
      const offer = await pc.createOffer();
      assert.ok(offer);
      assert.strictEqual(offer.type, 'offer');
      assert.ok(offer.sdp);
    });

    it('should throw when closed', async () => {
      pc.close();
      await assert.rejects(
        async () => await pc.createOffer(),
        /closed/
      );
    });
  });

  describe('createAnswer', () => {
    it('should create an answer', async () => {
      const offer = new RTCSessionDescription({ type: 'offer', sdp: 'test' });
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      assert.ok(answer);
      assert.strictEqual(answer.type, 'answer');
    });

    it('should throw when closed', async () => {
      pc.close();
      await assert.rejects(
        async () => await pc.createAnswer(),
        /closed/
      );
    });
  });

  describe('setLocalDescription', () => {
    it('should set local description with offer', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      assert.ok(pc.localDescription);
      assert.strictEqual(pc.localDescription.type, 'offer');
    });

    it('should set local description with answer', async () => {
      const offer = new RTCSessionDescription({ type: 'offer', sdp: 'test' });
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      assert.ok(pc.localDescription);
      assert.strictEqual(pc.localDescription.type, 'answer');
    });

    it('should update pending local description', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      assert.ok(pc.pendingLocalDescription);
    });
  });

  describe('setRemoteDescription', () => {
    it('should set remote description', async () => {
      const offer = new RTCSessionDescription({ type: 'offer', sdp: 'test' });
      await pc.setRemoteDescription(offer);
      assert.ok(pc.remoteDescription);
      assert.strictEqual(pc.remoteDescription.type, 'offer');
    });

    it('should update pending remote description', async () => {
      const offer = new RTCSessionDescription({ type: 'offer', sdp: 'test' });
      await pc.setRemoteDescription(offer);
      assert.ok(pc.pendingRemoteDescription);
    });
  });

  describe('addIceCandidate', () => {
    it('should add ice candidate', async () => {
      const candidate = {
        candidate: 'candidate:1 1 tcp 2130706431 192.168.1.1 9 typ host',
        sdpMid: 'data',
        sdpMLineIndex: 0
      };
      await pc.addIceCandidate(candidate);
      // Should not throw
    });

    it('should handle null candidate', async () => {
      await pc.addIceCandidate(null);
      // Should not throw
    });
  });

  describe('createDataChannel', () => {
    it('should create a data channel', () => {
      const channel = pc.createDataChannel('test');
      assert.ok(channel);
      assert.strictEqual(channel.label, 'test');
    });

    it('should create with options', () => {
      const channel = pc.createDataChannel('test', {
        ordered: false,
        maxRetransmits: 3,
        protocol: 'custom'
      });
      assert.ok(channel);
    });

    it('should throw when closed', () => {
      pc.close();
      assert.throws(() => {
        pc.createDataChannel('test');
      }, /closed/);
    });
  });

  describe('close', () => {
    it('should close the connection', () => {
      pc.close();
      assert.strictEqual(pc.signalingState, 'closed');
    });

    it('should not throw when closing twice', () => {
      pc.close();
      pc.close();
      // Should not throw
    });

    it('should close all data channels', () => {
      const ch1 = pc.createDataChannel('ch1');
      const ch2 = pc.createDataChannel('ch2');
      pc.close();
      // Channels should be closed
    });
  });

  describe('getStats', () => {
    it('should return stats', async () => {
      const stats = await pc.getStats();
      assert.ok(stats);
    });
  });

  describe('events', () => {
    it('should emit signalingstatechange', (t, done) => {
      pc.on('signalingstatechange', () => {
        done();
      });
      pc._nativePeerConnection.emit('signalingstatechange', 1);
    });

    it('should emit icecandidate', (t, done) => {
      pc.on('icecandidate', (event) => {
        assert.ok(event.candidate);
        done();
      });
      pc._nativePeerConnection.emit('icecandidate', { candidate: 'test' });
    });

    it('should emit datachannel', (t, done) => {
      pc.on('datachannel', (event) => {
        assert.ok(event.channel);
        done();
      });
      const mockChannel = new EventEmitter();
      mockChannel.label = 'remote';
      pc._nativePeerConnection.emit('datachannel', mockChannel);
    });
  });

  describe('state management', () => {
    it('should track signaling state', async () => {
      assert.strictEqual(pc.signalingState, 'stable');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      // State should change based on native events
    });

    it('should provide description accessors', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      assert.ok(pc.currentLocalDescription || pc.pendingLocalDescription);
    });
  });
});
