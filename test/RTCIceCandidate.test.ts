/**
 * Test suite for RTCIceCandidate
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import RTCIceCandidate from '../src/ice/RTCIceCandidate';

describe('RTCIceCandidate', () => {
  describe('construction', () => {
    it('should create with minimal init', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host',
        sdpMid: 'data'
      });

      assert.ok(candidate instanceof RTCIceCandidate);
      assert.strictEqual(candidate.sdpMid, 'data');
    });

    it('should create with sdpMLineIndex', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host',
        sdpMLineIndex: 0
      });

      assert.strictEqual(candidate.sdpMLineIndex, 0);
    });

    it('should throw if both sdpMid and sdpMLineIndex are null', () => {
      assert.throws(() => {
        new RTCIceCandidate({
          candidate: 'test',
          sdpMid: null,
          sdpMLineIndex: null
        });
      }, TypeError);
    });

    it('should accept empty candidate string', () => {
      const candidate = new RTCIceCandidate({
        candidate: '',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.candidate, '');
    });

    it('should store usernameFragment', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host',
        sdpMid: 'data',
        usernameFragment: 'abc123'
      });

      assert.strictEqual(candidate.usernameFragment, 'abc123');
    });
  });

  describe('candidate parsing', () => {
    it('should parse host candidate', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:842163049 1 udp 2130706431 192.168.1.100 54400 typ host',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.foundation, '842163049');
      assert.strictEqual(candidate.component, '1');
      assert.strictEqual(candidate.protocol, 'udp');
      assert.strictEqual(candidate.priority, 2130706431);
      assert.strictEqual(candidate.address, '192.168.1.100');
      assert.strictEqual(candidate.port, 54400);
      assert.strictEqual(candidate.type, 'host');
    });

    it('should parse srflx candidate with raddr/rport', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:842163049 1 udp 1694498815 203.0.113.1 54400 typ srflx raddr 192.168.1.100 rport 54321',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.type, 'srflx');
      assert.strictEqual(candidate.address, '203.0.113.1');
      assert.strictEqual(candidate.port, 54400);
      assert.strictEqual(candidate.relatedAddress, '192.168.1.100');
      assert.strictEqual(candidate.relatedPort, 54321);
    });

    it('should parse relay candidate', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:842163049 1 udp 16777215 198.51.100.1 54321 typ relay raddr 192.168.1.100 rport 54400',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.type, 'relay');
      assert.strictEqual(candidate.address, '198.51.100.1');
      assert.strictEqual(candidate.priority, 16777215);
    });

    it('should parse TCP candidate with tcptype', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:842163049 1 tcp 2130706175 192.168.1.100 9 typ host tcptype active',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.protocol, 'tcp');
      assert.strictEqual(candidate.tcpType, 'active');
    });

    it('should handle invalid candidate format gracefully', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'invalid candidate string',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.foundation, null);
      assert.strictEqual(candidate.type, null);
    });

    it('should handle empty candidate string', () => {
      const candidate = new RTCIceCandidate({
        candidate: '',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.foundation, null);
      assert.strictEqual(candidate.component, null);
    });
  });

  describe('getters', () => {
    const fullCandidate = new RTCIceCandidate({
      candidate: 'candidate:842163049 1 udp 1694498815 203.0.113.1 54400 typ srflx raddr 192.168.1.100 rport 54321',
      sdpMid: 'audio',
      sdpMLineIndex: 0,
      usernameFragment: 'test123'
    });

    it('should return candidate string', () => {
      assert.ok(fullCandidate.candidate.includes('candidate:'));
    });

    it('should return sdpMid', () => {
      assert.strictEqual(fullCandidate.sdpMid, 'audio');
    });

    it('should return sdpMLineIndex', () => {
      assert.strictEqual(fullCandidate.sdpMLineIndex, 0);
    });

    it('should return usernameFragment', () => {
      assert.strictEqual(fullCandidate.usernameFragment, 'test123');
    });

    it('should return parsed foundation', () => {
      assert.strictEqual(fullCandidate.foundation, '842163049');
    });

    it('should return parsed component', () => {
      assert.strictEqual(fullCandidate.component, '1');
    });

    it('should return parsed priority', () => {
      assert.strictEqual(fullCandidate.priority, 1694498815);
    });

    it('should return parsed address', () => {
      assert.strictEqual(fullCandidate.address, '203.0.113.1');
    });

    it('should return parsed protocol', () => {
      assert.strictEqual(fullCandidate.protocol, 'udp');
    });

    it('should return parsed port', () => {
      assert.strictEqual(fullCandidate.port, 54400);
    });

    it('should return parsed type', () => {
      assert.strictEqual(fullCandidate.type, 'srflx');
    });

    it('should return parsed relatedAddress', () => {
      assert.strictEqual(fullCandidate.relatedAddress, '192.168.1.100');
    });

    it('should return parsed relatedPort', () => {
      assert.strictEqual(fullCandidate.relatedPort, 54321);
    });
  });

  describe('toJSON', () => {
    it('should serialize to JSON', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host',
        sdpMid: 'data',
        sdpMLineIndex: 0,
        usernameFragment: 'frag123'
      });

      const json = candidate.toJSON();

      assert.strictEqual(json.candidate, 'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host');
      assert.strictEqual(json.sdpMid, 'data');
      assert.strictEqual(json.sdpMLineIndex, 0);
      assert.strictEqual(json.usernameFragment, 'frag123');
    });

    it('should omit null values from JSON', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host',
        sdpMid: 'data'
      });

      const json = candidate.toJSON();
      assert.ok(!('usernameFragment' in json));
    });
  });

  describe('static methods', () => {
    it('should create from string with fromString', () => {
      const candidate = RTCIceCandidate.fromString(
        'candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host',
        'data',
        0
      );

      assert.ok(candidate instanceof RTCIceCandidate);
      assert.strictEqual(candidate.sdpMid, 'data');
      assert.strictEqual(candidate.sdpMLineIndex, 0);
    });

    it('should validate valid candidate string', () => {
      const valid = RTCIceCandidate.isValid('candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host');
      assert.strictEqual(valid, true);
    });

    it('should reject invalid candidate string', () => {
      assert.strictEqual(RTCIceCandidate.isValid('invalid'), false);
      assert.strictEqual(RTCIceCandidate.isValid(''), false);
      assert.strictEqual(RTCIceCandidate.isValid(null as any), false);
      assert.strictEqual(RTCIceCandidate.isValid(undefined as any), false);
    });

    it('should reject candidate without enough fields', () => {
      assert.strictEqual(RTCIceCandidate.isValid('candidate:1 1 udp'), false);
    });
  });

  describe('real-world candidates', () => {
    it('should parse IPv6 host candidate', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:1 1 udp 2130706175 2001:0db8:85a3::8a2e:0370:7334 54321 typ host',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.address, '2001:0db8:85a3::8a2e:0370:7334');
      assert.strictEqual(candidate.type, 'host');
    });

    it('should parse complete relay candidate', () => {
      const candidate = new RTCIceCandidate({
        candidate: 'candidate:3 1 udp 16777215 198.51.100.1 54321 typ relay raddr 192.168.1.100 rport 54400',
        sdpMid: 'data'
      });

      assert.strictEqual(candidate.type, 'relay');
      assert.strictEqual(candidate.address, '198.51.100.1');
      assert.strictEqual(candidate.relatedAddress, '192.168.1.100');
    });
  });
});
