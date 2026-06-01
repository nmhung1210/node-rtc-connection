/**
 * @file url-parsing.test.ts
 * @description Tests for ICE server URL parsing with query strings, against the
 * live parser used by the ICE agent's candidate gathering.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseIceServerUrl } from '../src/ice/ice-agent';

describe('parseIceServerUrl', () => {
  it('parses a STUN URL without query string', () => {
    const r = parseIceServerUrl('stun:stun.example.com:3478')!;
    assert.strictEqual(r.protocol, 'stun');
    assert.strictEqual(r.host, 'stun.example.com');
    assert.strictEqual(r.port, 3478);
    assert.strictEqual(r.transport, 'udp');
    assert.deepStrictEqual(r.params, {});
  });

  it('parses a TURN URL with transport query parameter', () => {
    const r = parseIceServerUrl('turn:turn.example.com:3478?transport=tcp')!;
    assert.strictEqual(r.protocol, 'turn');
    assert.strictEqual(r.host, 'turn.example.com');
    assert.strictEqual(r.port, 3478);
    assert.strictEqual(r.transport, 'tcp');
    assert.deepStrictEqual(r.params, { transport: 'tcp' });
  });

  it('parses multiple query parameters', () => {
    const r = parseIceServerUrl('turn:turn.example.com:3478?transport=udp&ttl=86400&foo=bar')!;
    assert.strictEqual(r.transport, 'udp');
    assert.deepStrictEqual(r.params, { transport: 'udp', ttl: '86400', foo: 'bar' });
  });

  it('parses a URL with :// prefix', () => {
    const r = parseIceServerUrl('turn://turn.example.com:3478?transport=tcp')!;
    assert.strictEqual(r.protocol, 'turn');
    assert.strictEqual(r.host, 'turn.example.com');
    assert.strictEqual(r.transport, 'tcp');
  });

  it('uses the default port for STUN', () => {
    assert.strictEqual(parseIceServerUrl('stun:stun.example.com')!.port, 3478);
  });

  it('uses the default port for TURNS', () => {
    assert.strictEqual(parseIceServerUrl('turns:turn.example.com')!.port, 5349);
  });

  it('parses a TURNS URL (DTLS over UDP by default)', () => {
    const r = parseIceServerUrl('turns:turn.example.com:5349')!;
    assert.strictEqual(r.scheme, 'turns');
    assert.strictEqual(r.port, 5349);
    assert.strictEqual(r.transport, 'udp');
  });

  it('parses a TURNS URL with transport=tcp (TLS over TCP)', () => {
    const r = parseIceServerUrl('turns:turn.example.com:5349?transport=tcp')!;
    assert.strictEqual(r.scheme, 'turns');
    assert.strictEqual(r.port, 5349);
    assert.strictEqual(r.transport, 'tcp');
  });

  it('defaults to UDP transport when not specified', () => {
    assert.strictEqual(parseIceServerUrl('turn:turn.example.com:3478')!.transport, 'udp');
  });

  it('records a flag query parameter without a value as true', () => {
    const r = parseIceServerUrl('turn:turn.example.com:3478?transport=udp&secure')!;
    assert.strictEqual(r.params.secure, true);
    assert.strictEqual(r.params.transport, 'udp');
  });

  it('handles IPv4 addresses', () => {
    const r = parseIceServerUrl('stun:192.168.1.1:3478')!;
    assert.strictEqual(r.host, '192.168.1.1');
    assert.strictEqual(r.port, 3478);
  });

  it('handles domain names with hyphens', () => {
    assert.strictEqual(parseIceServerUrl('stun:my-stun-server.example.com:3478')!.host, 'my-stun-server.example.com');
  });

  it('returns null for a malformed URL', () => {
    assert.strictEqual(parseIceServerUrl('invalid-url'), null);
  });

  it('returns null for an unsupported scheme', () => {
    assert.strictEqual(parseIceServerUrl('http://example.com:3478'), null);
  });

  it('parses the Cloudflare TURN URL format', () => {
    const r = parseIceServerUrl('turn:turn.cloudflare.com:3478?transport=udp')!;
    assert.strictEqual(r.host, 'turn.cloudflare.com');
    assert.strictEqual(r.transport, 'udp');
  });

  it('parses an empty query parameter value', () => {
    const r = parseIceServerUrl('turn:turn.example.com:3478?transport=')!;
    assert.strictEqual(r.params.transport, '');
  });

  it('handles multiple ampersand-separated parameters', () => {
    const r = parseIceServerUrl('turn:turn.example.com:3478?a=1&b=2&c=3')!;
    assert.deepStrictEqual(r.params, { a: '1', b: '2', c: '3' });
  });

  it('parses every URL in a realistic iceServers config', () => {
    const config = [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'] },
    ];
    for (const server of config) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const url of urls) assert.ok(parseIceServerUrl(url), `failed to parse ${url}`);
    }
  });
});
