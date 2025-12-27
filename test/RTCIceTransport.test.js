/**
 * @file RTCIceTransport.test.js
 * @description Test suite for RTCIceTransport
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { 
  RTCIceTransport, 
  RTCIceRole, 
  RTCIceTransportState, 
  RTCIceGatheringState 
} = require('../src/ice/RTCIceTransport.js');

describe('RTCIceTransport', () => {
  describe('construction', () => {
    it('should initialize with default state', () => {
      const transport = new RTCIceTransport();
      
      assert.strictEqual(transport.role, null);
      assert.strictEqual(transport.state, RTCIceTransportState.NEW);
      assert.strictEqual(transport.gatheringState, RTCIceGatheringState.NEW);
      assert.strictEqual(transport.getLocalCandidates().length, 0);
      assert.strictEqual(transport.getRemoteCandidates().length, 0);
      assert.strictEqual(transport.getSelectedCandidatePair(), null);
      assert.strictEqual(transport.getLocalParameters(), null);
      assert.strictEqual(transport.getRemoteParameters(), null);
      assert.strictEqual(transport.isStarted(), false);
      assert.strictEqual(transport.isClosed(), false);
    });

    it('should be an EventEmitter', () => {
      const transport = new RTCIceTransport();
      assert.ok(typeof transport.on === 'function');
      assert.ok(typeof transport.emit === 'function');
    });
  });

  describe('gather', () => {
    it('should generate local parameters', async () => {
      const transport = new RTCIceTransport();
      await transport.gather();
      
      const params = transport.getLocalParameters();
      assert.ok(params !== null);
      assert.ok(typeof params.usernameFragment === 'string');
      assert.ok(params.usernameFragment.length > 0);
      assert.ok(typeof params.password === 'string');
      assert.ok(params.password.length > 0);
      
      transport.stop();
    });

    it('should transition to gathering state', async () => {
      const transport = new RTCIceTransport();
      
      let gatheringStateChanged = false;
      transport.on('gatheringstatechange', () => {
        if (transport.gatheringState === RTCIceGatheringState.GATHERING) {
          gatheringStateChanged = true;
        }
      });
      
      await transport.gather();
      
      assert.ok(gatheringStateChanged);
      transport.stop();
    });

    it('should throw if transport is closed', async () => {
      const transport = new RTCIceTransport();
      transport.stop();
      
      await assert.rejects(async () => {
        await transport.gather();
      }, /closed/);
    });
  });

  describe('start', () => {
    it('should accept valid parameters and role', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      assert.strictEqual(transport.role, RTCIceRole.CONTROLLING);
      assert.strictEqual(transport.state, RTCIceTransportState.CHECKING);
      assert.ok(transport.isStarted());
      
      const storedRemote = transport.getRemoteParameters();
      assert.strictEqual(storedRemote.usernameFragment, 'remotefrag');
      assert.strictEqual(storedRemote.password, 'remotepass123');
      
      transport.stop();
    });

    it('should generate local parameters if not gathered', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      
      transport.start(remoteParams, RTCIceRole.CONTROLLED);
      
      const localParams = transport.getLocalParameters();
      assert.ok(localParams !== null);
      assert.ok(localParams.usernameFragment.length > 0);
      assert.ok(localParams.password.length > 0);
      
      transport.stop();
    });

    it('should emit statechange event', (t, done) => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      
      let stateChanged = false;
      transport.on('statechange', () => {
        if (transport.state === RTCIceTransportState.CHECKING) {
          stateChanged = true;
        }
      });
      
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      // Use setImmediate to allow event to fire
      setImmediate(() => {
        assert.ok(stateChanged, 'State should have changed to checking');
        transport.stop();
        done();
      });
    });

    it('should throw if role is invalid', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      
      assert.throws(() => {
        transport.start(remoteParams, 'invalid-role');
      }, TypeError);
    });

    it('should throw if usernameFragment is missing', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        password: 'remotepass123'
      };
      
      assert.throws(() => {
        transport.start(remoteParams, RTCIceRole.CONTROLLING);
      }, TypeError);
    });

    it('should throw if password is missing', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag'
      };
      
      assert.throws(() => {
        transport.start(remoteParams, RTCIceRole.CONTROLLING);
      }, TypeError);
    });

    it('should throw if already started', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      assert.throws(() => {
        transport.start(remoteParams, RTCIceRole.CONTROLLED);
      }, /already started/);
    });

    it('should throw if transport is closed', () => {
      const transport = new RTCIceTransport();
      transport.stop();
      
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      
      assert.throws(() => {
        transport.start(remoteParams, RTCIceRole.CONTROLLING);
      }, /closed/);
    });
  });

  describe('addRemoteCandidate', () => {
    it('should add remote candidate', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      const candidate = {
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host',
        sdpMid: 'data',
        sdpMLineIndex: 0
      };
      
      transport.addRemoteCandidate(candidate);
      
      const remoteCandidates = transport.getRemoteCandidates();
      assert.strictEqual(remoteCandidates.length, 1);
      assert.deepStrictEqual(remoteCandidates[0], candidate);
      
      transport.stop();
    });

    it('should throw if not started', () => {
      const transport = new RTCIceTransport();
      const candidate = {
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host'
      };
      
      assert.throws(() => {
        transport.addRemoteCandidate(candidate);
      }, /not started/);
      
      transport.stop();
    });

    it('should throw if transport is closed', () => {
      const transport = new RTCIceTransport();
      transport.stop();
      
      const candidate = {
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host'
      };
      
      assert.throws(() => {
        transport.addRemoteCandidate(candidate);
      }, /closed/);
    });

    it('should throw if candidate is invalid', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      assert.throws(() => {
        transport.addRemoteCandidate(null);
      }, TypeError);      
      transport.stop();      
      transport.stop();
    });
  });

  describe('stop', () => {
    it('should transition to closed state', (t, done) => {
      const transport = new RTCIceTransport();
      
      transport.on('statechange', () => {
        if (transport.state === RTCIceTransportState.CLOSED) {
          assert.ok(transport.isClosed());
          done();
        }
      });
      
      transport.stop();
    });

    it('should be idempotent', () => {
      const transport = new RTCIceTransport();
      
      transport.stop();
      transport.stop(); // Should not throw
      
      assert.strictEqual(transport.state, RTCIceTransportState.CLOSED);
    });

    it('should clear candidates', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      const candidate = {
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host'
      };
      transport.addRemoteCandidate(candidate);
      
      transport.stop();
      
      assert.strictEqual(transport.getLocalCandidates().length, 0);
      assert.strictEqual(transport.getRemoteCandidates().length, 0);
      assert.strictEqual(transport.getSelectedCandidatePair(), null);
    });
  });

  describe('state management', () => {
    it('should not emit statechange if state does not change', () => {
      const transport = new RTCIceTransport();
      let eventCount = 0;
      
      transport.on('statechange', () => {
        eventCount++;
      });
      
      // Internal setState with same state
      transport._setState(RTCIceTransportState.NEW);
      
      assert.strictEqual(eventCount, 0);
      
      transport.stop();
    });

    it('should return copies of parameters', async () => {
      const transport = new RTCIceTransport();
      await transport.gather();
      
      const params1 = transport.getLocalParameters();
      const params2 = transport.getLocalParameters();
      
      assert.notStrictEqual(params1, params2); // Different objects
      assert.deepStrictEqual(params1, params2); // Same values
      
      transport.stop();
    });

    it('should return copies of candidate lists', () => {
      const transport = new RTCIceTransport();
      const remoteParams = {
        usernameFragment: 'remotefrag',
        password: 'remotepass123'
      };
      transport.start(remoteParams, RTCIceRole.CONTROLLING);
      
      const candidate = {
        candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 54321 typ host'
      };
      transport.addRemoteCandidate(candidate);
      
      const list1 = transport.getRemoteCandidates();
      const list2 = transport.getRemoteCandidates();
      
      assert.notStrictEqual(list1, list2); // Different arrays
      assert.deepStrictEqual(list1, list2); // Same contents
      
      transport.stop();
    });
  });

  describe('constants', () => {
    it('should expose RTCIceRole constants', () => {
      assert.strictEqual(RTCIceRole.CONTROLLING, 'controlling');
      assert.strictEqual(RTCIceRole.CONTROLLED, 'controlled');
    });

    it('should expose RTCIceTransportState constants', () => {
      assert.strictEqual(RTCIceTransportState.NEW, 'new');
      assert.strictEqual(RTCIceTransportState.CHECKING, 'checking');
      assert.strictEqual(RTCIceTransportState.CONNECTED, 'connected');
      assert.strictEqual(RTCIceTransportState.COMPLETED, 'completed');
      assert.strictEqual(RTCIceTransportState.DISCONNECTED, 'disconnected');
      assert.strictEqual(RTCIceTransportState.FAILED, 'failed');
      assert.strictEqual(RTCIceTransportState.CLOSED, 'closed');
    });

    it('should expose RTCIceGatheringState constants', () => {
      assert.strictEqual(RTCIceGatheringState.NEW, 'new');
      assert.strictEqual(RTCIceGatheringState.GATHERING, 'gathering');
      assert.strictEqual(RTCIceGatheringState.COMPLETE, 'complete');
    });

    it('RTCIceRole should be frozen', () => {
      'use strict';
      assert.throws(() => {
        RTCIceRole.CONTROLLING = 'modified';
      }, TypeError);
    });

    it('RTCIceTransportState should be frozen', () => {
      'use strict';
      assert.throws(() => {
        RTCIceTransportState.NEW = 'modified';
      }, TypeError);
    });

    it('RTCIceGatheringState should be frozen', () => {
      'use strict';
      assert.throws(() => {
        RTCIceGatheringState.NEW = 'modified';
      }, TypeError);
    });
  });
});
