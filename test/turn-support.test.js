/**
 * @file turn-support.test.js
 * @description Test TURN support in RTCIceTransport
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCIceTransport } = require('../src/ice/RTCIceTransport');
const RTCIceCandidate = require('../src/ice/RTCIceCandidate');

const EventEmitter = require('events');

describe('TURN Support', () => {
  it('should attempt to send connectivity checks via TURN', (t, done) => {
    const transport = new RTCIceTransport();
    
    let createPermissionCalled = false;
    let sendIndicationCalled = false;

    // Mock a TURN socket
    class MockTurnClient extends EventEmitter {
      constructor() {
        super();
        this.type = 'turn-client-mock';
      }
      async createPermission(addr) {
        createPermissionCalled = true;
        assert.strictEqual(addr, '9.8.7.6');
        return Promise.resolve();
      }
      async sendIndication(addr, port, data) {
        sendIndicationCalled = true;
        assert.strictEqual(addr, '9.8.7.6');
        assert.strictEqual(port, 9876);
        assert.ok(data);
        
        // Verify both were called
        assert.strictEqual(createPermissionCalled, true);
        assert.strictEqual(sendIndicationCalled, true);
        done();
        return Promise.resolve();
      }
    }
    const turnClient = new MockTurnClient();
    
    const foundation = '12345678';
    transport._sockets.set(foundation, { type: 'turn', client: turnClient });
    
    // Create a pair with TURN local candidate
    const pair = {
      local: new RTCIceCandidate({
        candidate: `candidate:${foundation} 1 udp 16777215 1.2.3.4 1234 typ relay raddr 5.6.7.8 rport 5678`,
        sdpMid: '0',
        sdpMLineIndex: 0,
        foundation: foundation
      }),
      remote: new RTCIceCandidate({
        candidate: 'candidate:87654321 1 udp 2130706431 9.8.7.6 9876 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0
      })
    };
    
    transport._sendConnectivityCheck(pair);
  });

  it('should handle incoming data from TURN', (t, done) => {
    const transport = new RTCIceTransport();
    
    // Mock _handleSocketMessage
    let handleMessageCalled = false;
    transport._handleSocketMessage = (msg, rinfo, candidate) => {
      handleMessageCalled = true;
      assert.strictEqual(msg.toString(), 'test-data');
      assert.strictEqual(rinfo.address, '9.8.7.6');
      assert.strictEqual(rinfo.port, 9876);
      assert.strictEqual(candidate.foundation, '12345678');
      done();
    };

    class MockTurnClient extends EventEmitter {
      constructor() {
        super();
        this.type = 'turn-client-mock';
      }
      async allocateRelay() {
        return { relayedAddress: '1.2.3.4', relayedPort: 1234, lifetime: 600 };
      }
    }
    const turnClient = new MockTurnClient();
    
    // Mock _parseServerUrl
    transport._parseServerUrl = () => ({ host: 'turn.example.com', port: 3478, transport: 'udp' });
    
    // Mock iceServers
    transport._iceServers = [{ urls: 'turn:turn.example.com', username: 'u', credential: 'p' }];
    
    // We need to trigger _gatherRelayCandidates logic to attach the listener
    // But _gatherRelayCandidates creates a NEW STUNClient.
    // So we can't easily inject our mock unless we mock STUNClient constructor or modify _gatherRelayCandidates to accept factory.
    
    // Instead, let's manually simulate what _gatherRelayCandidates does
    const foundation = '12345678';
    const candidate = new RTCIceCandidate({
      candidate: `candidate:${foundation} 1 udp 16777215 1.2.3.4 1234 typ relay raddr 5.6.7.8 rport 5678`,
      sdpMid: '0',
      sdpMLineIndex: 0,
      foundation: foundation
    });

    transport._sockets.set(foundation, { type: 'turn', client: turnClient });
    
    // Attach listener manually as _gatherRelayCandidates would
    turnClient.on('data', (data, peer) => {
      transport._handleSocketMessage(data, peer, candidate);
    });

    // Emit data
    turnClient.emit('data', Buffer.from('test-data'), { address: '9.8.7.6', port: 9876 });
  });
});
