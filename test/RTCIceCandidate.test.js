const assert = require('assert');
const { describe, it } = require('node:test');
const RTCIceCandidate = require('../src/RTCIceCandidate');

describe('RTCIceCandidate', () => {
  describe('constructor', () => {
    it('should create with empty object', () => {
      const candidate = new RTCIceCandidate();
      assert.strictEqual(candidate.candidate, '');
      assert.strictEqual(candidate.sdpMid, null);
      assert.strictEqual(candidate.sdpMLineIndex, null);
    });

    it('should create with candidate string', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 tcp 2130706431 192.168.1.1 9 typ host',
        sdpMid: 'data',
        sdpMLineIndex: 0
      });
      assert.ok(candidate.candidate.includes('candidate:'));
      assert.strictEqual(candidate.sdpMid, 'data');
      assert.strictEqual(candidate.sdpMLineIndex, 0);
    });
  });

  describe('candidate parsing', () => {
    it('should parse foundation', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:123456 1 tcp 2130706431 192.168.1.1 9 typ host'
      });
      assert.strictEqual(candidate.foundation, '123456');
    });

    it('should parse component', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 2 tcp 2130706431 192.168.1.1 9 typ host'
      });
      assert.strictEqual(candidate.component, '2');
    });

    it('should parse protocol', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 9 typ host'
      });
      assert.strictEqual(candidate.protocol, 'udp');
    });

    it('should parse priority', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 tcp 999 192.168.1.1 9 typ host'
      });
      assert.strictEqual(candidate.priority, 999);
    });

    it('should parse address and port', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 tcp 2130706431 10.0.0.1 54321 typ host'
      });
      assert.strictEqual(candidate.address, '10.0.0.1');
      assert.strictEqual(candidate.port, 54321);
    });

    it('should parse type', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 tcp 2130706431 192.168.1.1 9 typ srflx'
      });
      assert.strictEqual(candidate.type, 'srflx');
    });

    it('should parse related address and port', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 tcp 2130706431 1.2.3.4 9 typ relay raddr 192.168.1.1 rport 54321'
      });
      assert.strictEqual(candidate.relatedAddress, '192.168.1.1');
      assert.strictEqual(candidate.relatedPort, 54321);
    });
  });

  describe('toJSON', () => {
    it('should return JSON representation', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 tcp 2130706431 192.168.1.1 9 typ host',
        sdpMid: 'data',
        sdpMLineIndex: 0,
        usernameFragment: 'test'
      });
      const json = candidate.toJSON();
      assert.strictEqual(json.sdpMid, 'data');
      assert.strictEqual(json.sdpMLineIndex, 0);
      assert.strictEqual(json.usernameFragment, 'test');
    });
  });
});
