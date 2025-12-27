/**
 * Test for remote candidate validation and error handling
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCIceTransport, RTCIceRole } = require('../src/ice/RTCIceTransport.js');

describe('Remote Candidate Validation', () => {
  it('should handle candidate with missing port gracefully', () => {
    const transport = new RTCIceTransport();
    const remoteParams = {
      usernameFragment: 'remotefrag',
      password: 'remotepass123'
    };
    transport.start(remoteParams, RTCIceRole.CONTROLLING);
    
    // Candidate object missing port
    const candidate = {
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 typ host',
      sdpMid: 'data',
      sdpMLineIndex: 0
    };
    
    // Should not throw, but should warn and skip connectivity checks
    assert.doesNotThrow(() => {
      transport.addRemoteCandidate(candidate);
    });
    
    const remoteCandidates = transport.getRemoteCandidates();
    assert.strictEqual(remoteCandidates.length, 1);
    
    transport.stop();
  });

  it('should handle candidate with missing address gracefully', () => {
    const transport = new RTCIceTransport();
    const remoteParams = {
      usernameFragment: 'remotefrag',
      password: 'remotepass123'
    };
    transport.start(remoteParams, RTCIceRole.CONTROLLING);
    
    // Candidate object with malformed string
    const candidate = {
      candidate: 'candidate:1 1 UDP 2130706431',
      sdpMid: 'data',
      sdpMLineIndex: 0
    };
    
    // Should not throw
    assert.doesNotThrow(() => {
      transport.addRemoteCandidate(candidate);
    });
    
    transport.stop();
  });

  it('should work with valid remote candidate', () => {
    const transport = new RTCIceTransport();
    const remoteParams = {
      usernameFragment: 'remotefrag',
      password: 'remotepass123'
    };
    transport.start(remoteParams, RTCIceRole.CONTROLLING);
    
    // Valid candidate
    const candidate = {
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host',
      sdpMid: 'data',
      sdpMLineIndex: 0
    };
    
    assert.doesNotThrow(() => {
      transport.addRemoteCandidate(candidate);
    });
    
    const remoteCandidates = transport.getRemoteCandidates();
    assert.strictEqual(remoteCandidates.length, 1);
    assert.deepStrictEqual(remoteCandidates[0], candidate);
    
    transport.stop();
  });

  it('should handle RTCIceCandidate instance', () => {
    const transport = new RTCIceTransport();
    const remoteParams = {
      usernameFragment: 'remotefrag',
      password: 'remotepass123'
    };
    transport.start(remoteParams, RTCIceRole.CONTROLLING);
    
    const RTCIceCandidate = require('../src/ice/RTCIceCandidate.js');
    const candidate = new RTCIceCandidate({
      candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host',
      sdpMid: 'data',
      sdpMLineIndex: 0
    });
    
    assert.doesNotThrow(() => {
      transport.addRemoteCandidate(candidate);
    });
    
    const remoteCandidates = transport.getRemoteCandidates();
    assert.strictEqual(remoteCandidates.length, 1);
    
    transport.stop();
  });
});
