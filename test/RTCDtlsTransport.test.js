/**
 * @file RTCDtlsTransport.test.js
 * @description Test suite for RTCDtlsTransport
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCDtlsTransport, RTCDtlsTransportState } = require('../src/dtls/RTCDtlsTransport.js');
const { RTCIceTransport } = require('../src/ice/RTCIceTransport.js');

describe('RTCDtlsTransport', () => {
  describe('construction', () => {
    it('should create with ICE transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      assert.ok(dtlsTransport instanceof RTCDtlsTransport);
      assert.strictEqual(dtlsTransport.iceTransport, iceTransport);
      assert.strictEqual(dtlsTransport.state, RTCDtlsTransportState.NEW);
      assert.strictEqual(dtlsTransport.isClosed(), false);
    });

    it('should throw if iceTransport is not provided', () => {
      assert.throws(() => {
        new RTCDtlsTransport();
      }, TypeError);
    });

    it('should throw if iceTransport is invalid', () => {
      assert.throws(() => {
        new RTCDtlsTransport(null);
      }, TypeError);
      
      assert.throws(() => {
        new RTCDtlsTransport('invalid');
      }, TypeError);
    });

    it('should be an EventEmitter', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      assert.ok(typeof dtlsTransport.on === 'function');
      assert.ok(typeof dtlsTransport.emit === 'function');
    });
  });

  describe('iceTransport getter', () => {
    it('should return the underlying ICE transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      assert.strictEqual(dtlsTransport.iceTransport, iceTransport);
    });
  });

  describe('state', () => {
    it('should start in new state', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      assert.strictEqual(dtlsTransport.state, RTCDtlsTransportState.NEW);
    });

    it('should transition to connecting when ICE connects', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      let connectingSeen = false;
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CONNECTING) {
          connectingSeen = true;
        } else if (dtlsTransport.state === RTCDtlsTransportState.CONNECTED) {
          assert.ok(connectingSeen);
          done();
        }
      });
      
      // Simulate ICE connection
      iceTransport._setState('connected');
    });

    it('should transition to connected after handshake', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CONNECTED) {
          done();
        }
      });
      
      // Simulate ICE connection
      iceTransport._setState('connected');
    });

    it('should return closed state when closedFromOwner', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.close();
      
      assert.strictEqual(dtlsTransport.state, RTCDtlsTransportState.CLOSED);
    });
  });

  describe('close', () => {
    it('should transition to closed state', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      let closedSeen = false;
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CLOSED && !closedSeen) {
          closedSeen = true;
          done();
        }
      });
      
      dtlsTransport.close();
    });

    it('should stop the underlying ICE transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.close();
      
      assert.ok(iceTransport.isClosed());
    });

    it('should be idempotent', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.close();
      dtlsTransport.close(); // Should not throw
      
      assert.strictEqual(dtlsTransport.state, RTCDtlsTransportState.CLOSED);
    });

    it('should mark transport as closed', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.close();
      
      assert.ok(dtlsTransport.isClosed());
    });
  });

  describe('getRemoteCertificates', () => {
    it('should return empty array initially', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      const certs = dtlsTransport.getRemoteCertificates();
      assert.ok(Array.isArray(certs));
      assert.strictEqual(certs.length, 0);
    });

    it('should return copies of certificates', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      // Set some certificates internally
      const cert = new ArrayBuffer(32);
      dtlsTransport._setRemoteCertificates([cert]);
      
      const certs1 = dtlsTransport.getRemoteCertificates();
      const certs2 = dtlsTransport.getRemoteCertificates();
      
      // Different array instances
      assert.notStrictEqual(certs1, certs2);
      // Different buffer instances
      assert.notStrictEqual(certs1[0], certs2[0]);
      // But same length
      assert.strictEqual(certs1[0].byteLength, certs2[0].byteLength);
    });

    it('should handle multiple certificates', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      const cert1 = new ArrayBuffer(32);
      const cert2 = new ArrayBuffer(64);
      dtlsTransport._setRemoteCertificates([cert1, cert2]);
      
      const certs = dtlsTransport.getRemoteCertificates();
      assert.strictEqual(certs.length, 2);
      assert.strictEqual(certs[0].byteLength, 32);
      assert.strictEqual(certs[1].byteLength, 64);
    });
  });

  describe('ICE state integration', () => {
    it('should start DTLS when ICE is connected', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CONNECTING) {
          done();
        }
      });
      
      iceTransport._setState('connected');
    });

    it('should start DTLS when ICE is completed', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CONNECTING) {
          done();
        }
      });
      
      iceTransport._setState('completed');
    });

    it('should fail when ICE fails', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      // Suppress error event
      dtlsTransport.on('error', () => {});
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.FAILED) {
          done();
        }
      });
      
      iceTransport._setState('failed');
    });

    it('should close when ICE closes', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CLOSED) {
          done();
        }
      });
      
      iceTransport._setState('closed');
    });

    it('should emit error when transport fails', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('error', (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes('failed'));
        done();
      });
      
      iceTransport._setState('failed');
    });
  });

  describe('isClosed', () => {
    it('should return false for new transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      assert.strictEqual(dtlsTransport.isClosed(), false);
    });

    it('should return false for connecting transport', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CONNECTING) {
          assert.strictEqual(dtlsTransport.isClosed(), false);
          done();
        }
      });
      
      iceTransport._setState('connected');
    });

    it('should return false for connected transport', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.CONNECTED) {
          assert.strictEqual(dtlsTransport.isClosed(), false);
          done();
        }
      });
      
      iceTransport._setState('connected');
    });

    it('should return true for closed transport', () => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      dtlsTransport.close();
      
      assert.strictEqual(dtlsTransport.isClosed(), true);
    });

    it('should return true for failed transport', (t, done) => {
      const iceTransport = new RTCIceTransport();
      const dtlsTransport = new RTCDtlsTransport(iceTransport);
      
      // Suppress error event
      dtlsTransport.on('error', () => {});
      
      dtlsTransport.on('statechange', () => {
        if (dtlsTransport.state === RTCDtlsTransportState.FAILED) {
          assert.strictEqual(dtlsTransport.isClosed(), true);
          done();
        }
      });
      
      iceTransport._setState('failed');
    });
  });

  describe('constants', () => {
    it('should expose RTCDtlsTransportState constants', () => {
      assert.strictEqual(RTCDtlsTransportState.NEW, 'new');
      assert.strictEqual(RTCDtlsTransportState.CONNECTING, 'connecting');
      assert.strictEqual(RTCDtlsTransportState.CONNECTED, 'connected');
      assert.strictEqual(RTCDtlsTransportState.CLOSED, 'closed');
      assert.strictEqual(RTCDtlsTransportState.FAILED, 'failed');
    });

    it('RTCDtlsTransportState should be frozen', () => {
      'use strict';
      assert.throws(() => {
        RTCDtlsTransportState.NEW = 'modified';
      }, TypeError);
    });
  });
});
