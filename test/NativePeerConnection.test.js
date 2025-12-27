const assert = require('assert');
const { describe, it, beforeEach, afterEach } = require('node:test');
const NativePeerConnectionFactory = require('../src/NativePeerConnectionFactory');

describe('NativePeerConnectionFactory', () => {
  let factory;

  beforeEach(() => {
    factory = new NativePeerConnectionFactory();
  });

  afterEach(() => {
    if (factory) {
      factory.dispose();
    }
  });

  describe('initialization', () => {
    it('should initialize', () => {
      factory.initialize();
      assert.ok(factory._initialized);
    });

    it('should not initialize twice', () => {
      factory.initialize();
      factory.initialize(); // Should not throw
      assert.ok(factory._initialized);
    });
  });

  describe('createPeerConnection', () => {
    it('should create a peer connection', () => {
      const pc = factory.createPeerConnection({});
      assert.ok(pc);
      assert.ok(factory._peerConnections.has(pc));
      pc.close();
    });

    it('should initialize factory on first connection', () => {
      assert.strictEqual(factory._initialized, false);
      const pc = factory.createPeerConnection({});
      assert.ok(factory._initialized);
      pc.close();
    });

    it('should track multiple connections', () => {
      const pc1 = factory.createPeerConnection({});
      const pc2 = factory.createPeerConnection({});
      assert.strictEqual(factory._peerConnections.size, 2);
      pc1.close();
      pc2.close();
    });
  });

  describe('dispose', () => {
    it('should dispose all connections', () => {
      const pc1 = factory.createPeerConnection({});
      const pc2 = factory.createPeerConnection({});
      factory.dispose();
      assert.strictEqual(factory._peerConnections.size, 0);
      assert.strictEqual(factory._initialized, false);
    });
  });
});

describe('NativePeerConnection', () => {
  let factory;
  let pc;

  beforeEach(() => {
    factory = new NativePeerConnectionFactory();
    pc = factory.createPeerConnection({});
  });

  afterEach(() => {
    if (pc && !pc._closed) {
      pc.close();
    }
    if (factory) {
      factory.dispose();
    }
  });

  describe('createOffer', () => {
    it('should create an offer with SDP', async () => {
      const offer = await pc.createOffer();
      assert.ok(offer);
      assert.strictEqual(offer.type, 'offer');
      assert.ok(offer.sdp);
      assert.ok(offer.sdp.includes('v=0'));
    });

    it('should create TCP server', async () => {
      await pc.createOffer();
      assert.ok(pc._server);
      assert.ok(pc._localPort > 0);
      assert.ok(pc._localAddress);
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
      const offer = await pc.createOffer();
      
      const pc2 = factory.createPeerConnection({});
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      
      assert.ok(answer);
      assert.strictEqual(answer.type, 'answer');
      assert.ok(answer.sdp);
      
      pc2.close();
    });

    it('should throw without remote description', async () => {
      await assert.rejects(
        async () => await pc.createAnswer(),
        /No remote description/
      );
    });
  });

  describe('SDP operations', () => {
    it('should set local description', async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      assert.ok(pc._localDescription);
    });

    it('should parse remote SDP', async () => {
      const pc2 = factory.createPeerConnection({});
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      await pc2.setRemoteDescription(offer);
      assert.ok(pc2._remoteAddress);
      assert.ok(pc2._remotePort);
      
      pc2.close();
    });
  });

  describe('ICE candidates', () => {
    it('should generate ICE candidates', (t, done) => {
      let candidateReceived = false;
      
      pc.on('icecandidate', (candidate) => {
        if (candidate && !candidateReceived) {
          candidateReceived = true;
          assert.ok(candidate.candidate);
          assert.ok(candidate.candidate.includes('candidate:'));
        }
      });

      pc.on('icegatheringstatechange', (state) => {
        if (state === 2 && candidateReceived) { // complete
          done();
        }
      });

      pc.createOffer().then(offer => pc.setLocalDescription(offer));
    });

    it('should add ICE candidate', async () => {
      const candidate = {
        candidate: 'candidate:1 1 tcp 2130706431 192.168.1.1 9000 typ host',
        sdpMid: 'data',
        sdpMLineIndex: 0
      };
      await pc.addIceCandidate(candidate);
      assert.strictEqual(pc._remoteAddress, '192.168.1.1');
      assert.strictEqual(pc._remotePort, 9000);
    });
  });

  describe('data channels', () => {
    it('should create data channel', () => {
      const channel = pc.createDataChannel('test');
      assert.ok(channel);
      assert.strictEqual(channel.label, 'test');
      assert.ok(pc._dataChannels.has('test'));
    });

    it('should create with options', () => {
      const channel = pc.createDataChannel('test', {
        ordered: false,
        maxRetransmits: 3
      });
      assert.strictEqual(channel.ordered, false);
      assert.strictEqual(channel.maxRetransmits, 3);
    });

    it('should emit negotiationneeded', (t, done) => {
      pc.on('negotiationneeded', () => {
        done();
      });
      pc.createDataChannel('test');
    });
  });

  describe('close', () => {
    it('should close cleanly', () => {
      const channel = pc.createDataChannel('test');
      pc.close();
      assert.ok(pc._closed);
      assert.strictEqual(pc._signalingState, 5); // closed
    });

    it('should close server and socket', async () => {
      await pc.createOffer();
      const server = pc._server;
      pc.close();
      assert.strictEqual(pc._server, null);
    });
  });

  describe('configuration', () => {
    it('should store configuration', () => {
      const config = {
        iceServers: [{ urls: 'stun:test.com' }]
      };
      const pc = factory.createPeerConnection(config);
      assert.ok(pc._configuration);
      assert.strictEqual(pc._configuration.iceServers.length, 1);
      pc.close();
    });

    it('should update configuration', () => {
      const newConfig = {
        iceServers: [{ urls: 'stun:new.com' }]
      };
      pc.setConfiguration(newConfig);
      assert.ok(pc._configuration);
    });
  });
});

describe('NativeDataChannel', () => {
  let factory;
  let pc;
  let channel;

  beforeEach(() => {
    factory = new NativePeerConnectionFactory();
    pc = factory.createPeerConnection({});
    channel = pc.createDataChannel('test');
  });

  afterEach(() => {
    if (channel) {
      channel.close();
    }
    if (pc) {
      pc.close();
    }
    if (factory) {
      factory.dispose();
    }
  });

  describe('properties', () => {
    it('should have correct properties', () => {
      assert.strictEqual(channel.label, 'test');
      assert.strictEqual(channel.ordered, true);
      assert.strictEqual(channel._state, 0); // connecting
    });

    it('should respect options', () => {
      const ch = pc.createDataChannel('custom', {
        ordered: false,
        protocol: 'test-protocol',
        maxRetransmits: 5
      });
      assert.strictEqual(ch.ordered, false);
      assert.strictEqual(ch.protocol, 'test-protocol');
      assert.strictEqual(ch.maxRetransmits, 5);
      ch.close();
    });
  });

  describe('state transitions', () => {
    it('should transition to open', (t, done) => {
      channel.on('statechange', (state) => {
        if (state === 1) { // open
          assert.strictEqual(channel._state, 1);
          done();
        }
      });
      
      const net = require('net');
      const socket = new net.Socket();
      channel._setConnected(socket);
    });

    it('should transition to closed', (t, done) => {
      channel.on('statechange', (state) => {
        if (state === 3) { // closed
          done();
        }
      });
      channel.close();
    });
  });

  describe('close', () => {
    it('should close cleanly', () => {
      channel.close();
      assert.ok(channel._closed);
    });

    it('should not throw when closing twice', () => {
      channel.close();
      channel.close();
      // Should not throw
    });
  });
});
