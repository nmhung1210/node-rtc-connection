const assert = require('assert');
const { describe, it, afterEach } = require('node:test');
const { createPeerConnection } = require('../src');

// Skip integration tests in CI or when running all tests
// These tests use real TCP networking and take longer
// Run them separately with: node --test test/integration.test.js
const SKIP_INTEGRATION = process.env.SKIP_INTEGRATION === '1';

describe('Integration Tests', { skip: SKIP_INTEGRATION }, () => {
  const peerConnections = [];

  afterEach(() => {
    // Clean up all peer connections
    peerConnections.forEach(pc => {
      try {
        if (pc && pc.signalingState !== 'closed') {
          pc.close();
        }
      } catch (e) {
        // Ignore
      }
    });
    peerConnections.length = 0;
  });

  describe('Peer Connection Establishment', () => {
    it('should establish connection between two peers', async () => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      // Exchange ICE candidates
      pc1.on('icecandidate', (event) => {
        if (event.candidate) {
          pc2.addIceCandidate(event.candidate).catch(() => {});
        }
      });

      pc2.on('icecandidate', (event) => {
        if (event.candidate) {
          pc1.addIceCandidate(event.candidate).catch(() => {});
        }
      });

      // Create offer
      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);

      // Set remote description on pc2
      await pc2.setRemoteDescription(offer);

      // Create answer
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);

      // Set remote description on pc1
      await pc1.setRemoteDescription(answer);

      assert.strictEqual(pc1.signalingState, 'stable');
      assert.strictEqual(pc2.signalingState, 'stable');
    });

    it('should exchange signaling state changes', async () => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      let pc1StateChanges = 0;
      let pc2StateChanges = 0;

      pc1.on('signalingstatechange', () => pc1StateChanges++);
      pc2.on('signalingstatechange', () => pc2StateChanges++);

      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);

      assert.ok(pc1StateChanges > 0);
      assert.ok(pc2StateChanges > 0);
    });
  });

  describe('DataChannel Communication', () => {
    it('should create and receive remote data channel', (t, done) => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      const timeout = setTimeout(() => {
        done(new Error('Test timed out'));
      }, 5000);

      pc2.on('datachannel', (event) => {
        clearTimeout(timeout);
        assert.ok(event.channel);
        assert.strictEqual(event.channel.label, 'test');
        done();
      });

      const channel = pc1.createDataChannel('test');

      // Quick signaling
      pc1.createOffer()
        .then(offer => pc1.setLocalDescription(offer))
        .then(() => pc2.setRemoteDescription(pc1.localDescription))
        .then(() => pc2.createAnswer())
        .then(answer => pc2.setLocalDescription(answer))
        .then(() => pc1.setRemoteDescription(pc2.localDescription))
        .catch(err => {
          clearTimeout(timeout);
          done(err);
        });
    });

    it('should send and receive messages', (t, done) => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      let channel1, channel2;
      let messagesReceived = 0;
      
      const timeout = setTimeout(() => {
        done(new Error('Test timed out waiting for messages'));
      }, 8000);

      pc1.on('icecandidate', e => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {}));
      pc2.on('icecandidate', e => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {}));

      pc2.on('datachannel', (event) => {
        channel2 = event.channel;
        
        channel2.on('message', (e) => {
          const msg = e.data.toString();
          messagesReceived++;
          
          if (msg === 'Hello from PC1') {
            // Send reply
            setTimeout(() => {
              try {
                channel2.send('Hello from PC2');
              } catch (err) {
                clearTimeout(timeout);
                done(err);
              }
            }, 100);
          }
        });
      });

      channel1 = pc1.createDataChannel('chat');

      channel1.on('open', () => {
        setTimeout(() => {
          try {
            channel1.send('Hello from PC1');
          } catch (err) {
            clearTimeout(timeout);
            done(err);
          }
        }, 100);
      });

      channel1.on('message', (e) => {
        const msg = e.data.toString();
        messagesReceived++;
        
        if (msg === 'Hello from PC2') {
          clearTimeout(timeout);
          assert.strictEqual(messagesReceived, 2);
          done();
        }
      });

      // Establish connection
      (async () => {
        try {
          const offer = await pc1.createOffer();
          await pc1.setLocalDescription(offer);
          await new Promise(r => setTimeout(r, 100));
          await pc2.setRemoteDescription(offer);
          const answer = await pc2.createAnswer();
          await pc2.setLocalDescription(answer);
          await new Promise(r => setTimeout(r, 100));
          await pc1.setRemoteDescription(answer);
        } catch (err) {
          clearTimeout(timeout);
          done(err);
        }
      })();
    });

    it('should handle binary data', (t, done) => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      let channel1, channel2;
      
      const timeout = setTimeout(() => {
        done(new Error('Test timed out waiting for binary data'));
      }, 8000);

      pc1.on('icecandidate', e => e.candidate && pc2.addIceCandidate(e.candidate).catch(() => {}));
      pc2.on('icecandidate', e => e.candidate && pc1.addIceCandidate(e.candidate).catch(() => {}));

      pc2.on('datachannel', (event) => {
        channel2 = event.channel;
        channel2.binaryType = 'arraybuffer';
        
        channel2.on('message', (e) => {
          clearTimeout(timeout);
          try {
            assert.ok(e.data instanceof ArrayBuffer || Buffer.isBuffer(e.data));
            const view = new Uint8Array(e.data);
            assert.strictEqual(view[0], 1);
            assert.strictEqual(view[1], 2);
            assert.strictEqual(view[2], 3);
            done();
          } catch (err) {
            done(err);
          }
        });
      });

      channel1 = pc1.createDataChannel('binary');

      channel1.on('open', () => {
        setTimeout(() => {
          const buffer = new Uint8Array([1, 2, 3, 4, 5]);
          try {
            channel1.send(buffer);
          } catch (err) {
            clearTimeout(timeout);
            done(err);
          }
        }, 100);
      });

      // Establish connection
      (async () => {
        try {
          const offer = await pc1.createOffer();
          await pc1.setLocalDescription(offer);
          await new Promise(r => setTimeout(r, 100));
          await pc2.setRemoteDescription(offer);
          const answer = await pc2.createAnswer();
          await pc2.setLocalDescription(answer);
          await new Promise(r => setTimeout(r, 100));
          await pc1.setRemoteDescription(answer);
        } catch (err) {
          clearTimeout(timeout);
          done(err);
        }
      })();
    });
  });

  describe('Connection Lifecycle', () => {
    it('should handle connection close gracefully', async () => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);

      pc1.close();
      assert.strictEqual(pc1.signalingState, 'closed');

      pc2.close();
      assert.strictEqual(pc2.signalingState, 'closed');
    });

    it('should close data channels on connection close', async () => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      const channel = pc1.createDataChannel('test');

      const offer = await pc1.createOffer();
      await pc1.setLocalDescription(offer);
      await pc2.setRemoteDescription(offer);
      const answer = await pc2.createAnswer();
      await pc2.setLocalDescription(answer);
      await pc1.setRemoteDescription(answer);

      pc1.close();
      
      // Channel should be closed or closing
      assert.ok(['closing', 'closed'].includes(channel.readyState));
    });
  });

  describe('Error Handling', () => {
    it('should throw on operations after close', () => {
      const pc = createPeerConnection({});
      peerConnections.push(pc);
      
      pc.close();
      
      assert.throws(() => {
        pc.createDataChannel('test');
      }, /closed/);
    });

    it('should handle invalid SDP gracefully', async () => {
      const pc = createPeerConnection({});
      peerConnections.push(pc);

      // Should not crash, may throw or handle gracefully
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: 'invalid' });
      } catch (e) {
        // Expected to potentially throw
      }
    });
  });

  describe('Multiple Data Channels', () => {
    it('should support multiple data channels', (t, done) => {
      const pc1 = createPeerConnection({});
      const pc2 = createPeerConnection({});
      peerConnections.push(pc1, pc2);

      const ch1 = pc1.createDataChannel('channel1');
      const ch2 = pc1.createDataChannel('channel2');

      let receivedChannels = 0;
      
      const timeout = setTimeout(() => {
        done(new Error(`Test timed out, only received ${receivedChannels} channels`));
      }, 8000);

      pc2.on('datachannel', (event) => {
        receivedChannels++;
        if (receivedChannels === 2) {
          clearTimeout(timeout);
          done();
        }
      });

      // Establish connection
      (async () => {
        try {
          const offer = await pc1.createOffer();
          await pc1.setLocalDescription(offer);
          await new Promise(r => setTimeout(r, 100));
          await pc2.setRemoteDescription(offer);
          const answer = await pc2.createAnswer();
          await pc2.setLocalDescription(answer);
          await new Promise(r => setTimeout(r, 100));
          await pc1.setRemoteDescription(answer);
        } catch (err) {
          clearTimeout(timeout);
          done(err);
        }
      })();
    });
  });
});
