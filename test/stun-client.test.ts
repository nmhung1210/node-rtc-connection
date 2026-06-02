/**
 * @file stun-client.test.ts
 * @description Docker-free coverage for the STUNClient transports added for the
 * turns: scheme: TLS over TCP (with STUN stream re-framing) and DTLS over UDP.
 * Each test stands up a minimal in-process STUN responder — a real TLS server
 * or a DtlsConnection server — so the encrypted client path is exercised end to
 * end without any external coturn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as dgram from 'node:dgram';
import STUNClient from '../src/stun/stun-client';
import { DtlsConnection, ROLE } from '../src/dtls/connection';
import * as x509 from '../src/crypto/x509';

const MAGIC_COOKIE = 0x2112a442;

/** Build a STUN Binding success response carrying XOR-MAPPED-ADDRESS. */
function bindingResponse(txid: Buffer, address: string, port: number): Buffer {
  const value = Buffer.alloc(8);
  value.writeUInt8(0, 0); // reserved
  value.writeUInt8(0x01, 1); // family IPv4
  value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
  const parts = address.split('.').map(Number);
  const addrInt = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  value.writeUInt32BE((addrInt ^ MAGIC_COOKIE) >>> 0, 4);

  const attr = Buffer.alloc(4 + value.length);
  attr.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
  attr.writeUInt16BE(value.length, 2);
  value.copy(attr, 4);

  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0101, 0); // Binding success response
  header.writeUInt16BE(attr.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  txid.copy(header, 8);
  return Buffer.concat([header, attr]);
}

/** An unrelated, well-formed STUN message with a random txid (to be ignored). */
function strayMessage(): Buffer {
  const txid = Buffer.alloc(12, 0xaa);
  return bindingResponse(txid, '9.9.9.9', 9999);
}

/** Self-signed PEM key/cert for the in-process TLS server. */
function selfSignedPem() {
  const c = x509.generateSelfSigned({ commonName: 'stun-test-server' });
  const cert =
    '-----BEGIN CERTIFICATE-----\n' +
    c.certDer.toString('base64').match(/.{1,64}/g)!.join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const key = c.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { key, cert };
}

describe('STUNClient TLS-over-TCP transport', () => {
  it('completes a Binding request over TLS and parses the reflexive address', async () => {
    const { key, cert } = selfSignedPem();
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on('data', (req: Buffer) => {
        socket.write(bindingResponse(req.subarray(8, 20), '203.0.113.7', 51000));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    const client = new STUNClient({ server: '127.0.0.1', port, secure: true, transport: 'tcp', rejectUnauthorized: false });
    try {
      const res: any = await client.getReflexiveAddress();
      assert.strictEqual(res.address, '203.0.113.7');
      assert.strictEqual(res.port, 51000);
    } finally {
      client.close();
      server.close();
    }
  });

  it('re-frames a response split across two TCP writes', async () => {
    const { key, cert } = selfSignedPem();
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on('data', (req: Buffer) => {
        const msg = bindingResponse(req.subarray(8, 20), '198.51.100.9', 40000);
        // Deliberately fragment the STUN message across the stream.
        socket.write(msg.subarray(0, 10));
        setTimeout(() => socket.write(msg.subarray(10)), 20);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    const client = new STUNClient({ server: '127.0.0.1', port, secure: true, transport: 'tcp', rejectUnauthorized: false });
    try {
      const res: any = await client.getReflexiveAddress();
      assert.strictEqual(res.address, '198.51.100.9');
      assert.strictEqual(res.port, 40000);
    } finally {
      client.close();
      server.close();
    }
  });

  it('handles two STUN messages coalesced in one TCP write', async () => {
    const { key, cert } = selfSignedPem();
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on('data', (req: Buffer) => {
        const real = bindingResponse(req.subarray(8, 20), '192.0.2.5', 33333);
        // A stray message (unknown txid) precedes the real one in a single write;
        // the client must frame both, ignore the stray, and resolve on the match.
        socket.write(Buffer.concat([strayMessage(), real]));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    const client = new STUNClient({ server: '127.0.0.1', port, secure: true, transport: 'tcp', rejectUnauthorized: false });
    try {
      const res: any = await client.getReflexiveAddress();
      assert.strictEqual(res.address, '192.0.2.5');
      assert.strictEqual(res.port, 33333);
    } finally {
      client.close();
      server.close();
    }
  });

  it('rejects a self-signed server certificate by default', async () => {
    const { key, cert } = selfSignedPem();
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on('data', (req: Buffer) => socket.write(bindingResponse(req.subarray(8, 20), '203.0.113.7', 51000)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    // No rejectUnauthorized → defaults to true → the self-signed cert is rejected.
    const client = new STUNClient({ server: '127.0.0.1', port, secure: true, transport: 'tcp' });
    try {
      await assert.rejects(client.getReflexiveAddress(), /self.signed|certificate/i);
    } finally {
      client.close();
      server.close();
    }
  });

  it('accepts a self-signed server certificate when rejectUnauthorized is false', async () => {
    const { key, cert } = selfSignedPem();
    const server = tls.createServer({ key, cert }, (socket) => {
      socket.on('data', (req: Buffer) => socket.write(bindingResponse(req.subarray(8, 20), '203.0.113.7', 51000)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    const client = new STUNClient({ server: '127.0.0.1', port, secure: true, transport: 'tcp', rejectUnauthorized: false });
    try {
      const res: any = await client.getReflexiveAddress();
      assert.strictEqual(res.address, '203.0.113.7');
    } finally {
      client.close();
      server.close();
    }
  });
});

describe('STUNClient DTLS-over-UDP transport', () => {
  it('completes a Binding request over DTLS and parses the reflexive address', async () => {
    const serverCert = x509.generateSelfSigned({ commonName: 'dtls-stun-server' });
    const socket = dgram.createSocket('udp4');
    let conn: DtlsConnection | null = null;

    socket.on('message', (msg, rinfo) => {
      if (!conn) {
        conn = new DtlsConnection({
          role: ROLE.SERVER,
          certDer: serverCert.certDer,
          privateKey: serverCert.privateKey,
          verifyFingerprint: () => true,
          output: (dg: Buffer) => socket.send(dg, rinfo.port, rinfo.address),
        });
        // Once decrypted STUN requests arrive, reply with a binding response.
        conn.on('data', (req: Buffer) => {
          conn!.send(bindingResponse(req.subarray(8, 20), '203.0.113.42', 60000));
        });
        conn.start();
      }
      conn.handlePacket(msg);
    });
    await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
    const port = (socket.address() as net.AddressInfo).port;

    const client = new STUNClient({ server: '127.0.0.1', port, secure: true, transport: 'udp' });
    try {
      const res: any = await client.getReflexiveAddress();
      assert.strictEqual(res.address, '203.0.113.42');
      assert.strictEqual(res.port, 60000);
    } finally {
      client.close();
      socket.close();
    }
  });
});
