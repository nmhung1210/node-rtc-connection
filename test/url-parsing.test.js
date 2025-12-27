/**
 * @file url-parsing.test.js
 * @description Tests for URL parsing with query strings
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCIceTransport } = require('../src/ice/RTCIceTransport.js');

describe('URL Parsing with Query Strings', () => {
  describe('_parseServerUrl', () => {
    it('should parse STUN URL without query string', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('stun:stun.example.com:3478');
      assert.strictEqual(result.protocol, 'stun');
      assert.strictEqual(result.host, 'stun.example.com');
      assert.strictEqual(result.port, 3478);
      assert.strictEqual(result.transport, 'udp');
      assert.deepStrictEqual(result.params, {});
      transport.stop();
    });

    it('should parse TURN URL with transport query parameter', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.example.com:3478?transport=tcp');
      assert.strictEqual(result.protocol, 'turn');
      assert.strictEqual(result.host, 'turn.example.com');
      assert.strictEqual(result.port, 3478);
      assert.strictEqual(result.transport, 'tcp');
      assert.deepStrictEqual(result.params, { transport: 'tcp' });
      transport.stop();
    });

    it('should parse URL with multiple query parameters', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.example.com:3478?transport=udp&ttl=86400&foo=bar');
      assert.strictEqual(result.protocol, 'turn');
      assert.strictEqual(result.host, 'turn.example.com');
      assert.strictEqual(result.port, 3478);
      assert.strictEqual(result.transport, 'udp');
      assert.deepStrictEqual(result.params, { transport: 'udp', ttl: '86400', foo: 'bar' });
      transport.stop();
    });

    it('should parse URL with :// prefix', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn://turn.example.com:3478?transport=tcp');
      assert.strictEqual(result.protocol, 'turn');
      assert.strictEqual(result.host, 'turn.example.com');
      assert.strictEqual(result.port, 3478);
      assert.strictEqual(result.transport, 'tcp');
      transport.stop();
    });

    it('should use default port for STUN', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('stun:stun.example.com');
      assert.strictEqual(result.port, 3478);
      transport.stop();
    });

    it('should use default port for TURNS', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turns:turn.example.com');
      assert.strictEqual(result.port, 5349);
      transport.stop();
    });

    it('should default to UDP transport when not specified', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.example.com:3478');
      assert.strictEqual(result.transport, 'udp');
      transport.stop();
    });

    it('should parse query parameter without value', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.example.com:3478?transport=udp&secure');
      assert.strictEqual(result.params.secure, true);
      assert.strictEqual(result.params.transport, 'udp');
      transport.stop();
    });

    it('should handle IPv4 addresses', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('stun:192.168.1.1:3478');
      assert.strictEqual(result.host, '192.168.1.1');
      assert.strictEqual(result.port, 3478);
      transport.stop();
    });

    it('should handle domain names with hyphens', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('stun:my-stun-server.example.com:3478');
      assert.strictEqual(result.host, 'my-stun-server.example.com');
      transport.stop();
    });

    it('should throw error for invalid URL', () => {
      const transport = new RTCIceTransport();
      assert.throws(() => {
        transport._parseServerUrl('invalid-url');
      }, /Invalid server URL/);
      transport.stop();
    });

    it('should throw error for unsupported protocol', () => {
      const transport = new RTCIceTransport();
      assert.throws(() => {
        transport._parseServerUrl('http://example.com:3478');
      }, /Invalid server URL/);
      transport.stop();
    });

    it('should parse Cloudflare TURN URL format', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.cloudflare.com:3478?transport=udp');
      assert.strictEqual(result.protocol, 'turn');
      assert.strictEqual(result.host, 'turn.cloudflare.com');
      assert.strictEqual(result.port, 3478);
      assert.strictEqual(result.transport, 'udp');
      transport.stop();
    });

    it('should parse URL with empty query parameter', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.example.com:3478?transport=');
      assert.strictEqual(result.params.transport, '');
      transport.stop();
    });

    it('should handle multiple ampersands in query string', () => {
      const transport = new RTCIceTransport();
      const result = transport._parseServerUrl('turn:turn.example.com:3478?a=1&b=2&c=3');
      assert.deepStrictEqual(result.params, { a: '1', b: '2', c: '3' });
      transport.stop();
    });
  });

  describe('Integration with ICE server configuration', () => {
    it('should work with real peer config format', async () => {
      const transport = new RTCIceTransport();
      
      const testConfig = {
        iceServers: [
          {
            urls: 'stun:stun.cloudflare.com:3478'
          },
          {
            urls: [
              'turn:turn.cloudflare.com:3478?transport=udp',
              'turn:turn.cloudflare.com:53?transport=udp'
            ],
            username: 'testuser',
            credential: 'testpass'
          }
        ]
      };

      // This should not throw
      assert.doesNotThrow(() => {
        for (const server of testConfig.iceServers) {
          const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
          for (const url of urls) {
            transport._parseServerUrl(url);
          }
        }
      });

      transport.stop();
    });
  });
});
