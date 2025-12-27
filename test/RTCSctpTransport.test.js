/**
 * @file RTCSctpTransport.test.js
 * @description Test suite for RTCSctpTransport
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCSctpTransport, RTCSctpTransportState } = require('../src/sctp/RTCSctpTransport.js');
const { RTCDtlsTransport } = require('../src/dtls/RTCDtlsTransport.js');
const { RTCIceTransport } = require('../src/ice/RTCIceTransport.js');

describe('RTCSctpTransport', () => {
  describe('construction', () => {
    it('should create with DTLS transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.ok(sctpTransport instanceof RTCSctpTransport);
      assert.strictEqual(sctpTransport.transport, dtlsTransport);
      assert.strictEqual(sctpTransport.state, RTCSctpTransportState.CONNECTING);
      assert.strictEqual(sctpTransport.isClosed(), false);
    });

    it('should throw if dtlsTransport is not provided', () => {
      assert.throws(() => {
        new RTCSctpTransport();
      }, TypeError);
    });

    it('should throw if dtlsTransport is invalid', () => {
      assert.throws(() => {
        new RTCSctpTransport(null);
      }, TypeError);
      
      assert.throws(() => {
        new RTCSctpTransport('invalid');
      }, TypeError);
    });

    it('should accept custom options', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport, {
        maxMessageSize: 128 * 1024,
        maxChannels: 1024
      });
      
      assert.strictEqual(sctpTransport.maxMessageSize, 128 * 1024);
      assert.strictEqual(sctpTransport.maxChannels, 1024);
    });

    it('should be an EventEmitter', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.ok(typeof sctpTransport.on === 'function');
      assert.ok(typeof sctpTransport.emit === 'function');
    });
  });

  describe('transport getter', () => {
    it('should return the underlying DTLS transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.strictEqual(sctpTransport.transport, dtlsTransport);
    });
  });

  describe('state', () => {
    it('should start in connecting state', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.strictEqual(sctpTransport.state, RTCSctpTransportState.CONNECTING);
    });

    it('should transition to connected when DTLS connects', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.on('statechange', () => {
        if (sctpTransport.state === RTCSctpTransportState.CONNECTED) {
          done();
        }
      });
      
      // Trigger DTLS connection
      iceTransport._setState('connected');
    });

    it('should return closed state when closedFromOwner', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.close();
      
      assert.strictEqual(sctpTransport.state, RTCSctpTransportState.CLOSED);
    });
  });

  describe('maxMessageSize', () => {
    it('should return default max message size', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.strictEqual(sctpTransport.maxMessageSize, 256 * 1024);
    });

    it('should return custom max message size', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport, {
        maxMessageSize: 512 * 1024
      });
      
      assert.strictEqual(sctpTransport.maxMessageSize, 512 * 1024);
    });

    it('should return Infinity if max message size is null', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport, {
        maxMessageSize: null
      });
      
      assert.strictEqual(sctpTransport.maxMessageSize, Infinity);
    });
  });

  describe('maxChannels', () => {
    it('should return default max channels', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.strictEqual(sctpTransport.maxChannels, 65535);
    });

    it('should return custom max channels', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport, {
        maxChannels: 1024
      });
      
      assert.strictEqual(sctpTransport.maxChannels, 1024);
    });

    it('should return null if explicitly set to null', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport, {
        maxChannels: null
      });
      
      assert.strictEqual(sctpTransport.maxChannels, null);
    });
  });

  describe('close', () => {
    it('should transition to closed state', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      let closedSeen = false;
      sctpTransport.on('statechange', () => {
        if (sctpTransport.state === RTCSctpTransportState.CLOSED && !closedSeen) {
          closedSeen = true;
          done();
        }
      });
      
      sctpTransport.close();
    });

    it('should be idempotent', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.close();
      sctpTransport.close(); // Should not throw
      
      assert.strictEqual(sctpTransport.state, RTCSctpTransportState.CLOSED);
    });

    it('should mark transport as closed', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.close();
      
      assert.ok(sctpTransport.isClosed());
    });
  });

  describe('DTLS state integration', () => {
    it('should start SCTP when DTLS is connected', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.on('statechange', () => {
        if (sctpTransport.state === RTCSctpTransportState.CONNECTED) {
          done();
        }
      });
      
      // Trigger DTLS connection
      iceTransport._setState('connected');
    });

    it('should close when DTLS closes', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.on('statechange', () => {
        if (sctpTransport.state === RTCSctpTransportState.CLOSED) {
          done();
        }
      });
      
      dtlsTransport.close();
    });

    it('should close when DTLS fails', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      // Suppress error event
      dtlsTransport.on('error', () => {});
      
      sctpTransport.on('statechange', () => {
        if (sctpTransport.state === RTCSctpTransportState.CLOSED) {
          done();
        }
      });
      
      // Trigger DTLS failure
      iceTransport._setState('failed');
    });

    it('should connect immediately if DTLS is already connected', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      // Connect DTLS first
      iceTransport._setState('connected');
      
      // Wait for DTLS to connect
      setTimeout(() => {
        const sctpTransport = new RTCSctpTransport(dtlsTransport);
        
        sctpTransport.on('statechange', () => {
          if (sctpTransport.state === RTCSctpTransportState.CONNECTED) {
            done();
          }
        });
      }, 150);
    });
  });

  describe('isClosed', () => {
    it('should return false for connecting transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      assert.strictEqual(sctpTransport.isClosed(), false);
    });

    it('should return false for connected transport', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.on('statechange', () => {
        if (sctpTransport.state === RTCSctpTransportState.CONNECTED) {
          assert.strictEqual(sctpTransport.isClosed(), false);
          done();
        }
      });
      
      iceTransport._setState('connected');
    });

    it('should return true for closed transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      const sctpTransport = new RTCSctpTransport(dtlsTransport);
      
      sctpTransport.close();
      
      assert.strictEqual(sctpTransport.isClosed(), true);
    });
  });

  describe('constants', () => {
    it('should expose RTCSctpTransportState constants', () => {
      assert.strictEqual(RTCSctpTransportState.CONNECTING, 'connecting');
      assert.strictEqual(RTCSctpTransportState.CONNECTED, 'connected');
      assert.strictEqual(RTCSctpTransportState.CLOSED, 'closed');
    });

    it('RTCSctpTransportState should be frozen', () => {
      'use strict';
      assert.throws(() => {
        RTCSctpTransportState.CONNECTING = 'modified';
      }, TypeError);
    });
  });
});
