/**
 * @file dtls-openssl-interop.test.ts
 * @description Interop tests for the pure-Node DTLS 1.2 stack against OpenSSL.
 *
 * OpenSSL shares its DTLS/TLS lineage with the BoringSSL/NSS stacks browsers
 * use, so a successful mutually-authenticated handshake with `openssl s_server`
 * / `s_client` is strong evidence of browser interoperability for the cipher
 * suite WebRTC negotiates (ECDHE-ECDSA-AES128-GCM-SHA256).
 *
 * Skipped when openssl is unavailable or SKIP_INTEGRATION is set.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DtlsConnection, ROLE } from '../src/dtls/connection';
import * as x509 from '../src/crypto/x509';

const SKIP = process.env.SKIP_INTEGRATION === '1';

function hasOpenSSLDtls() {
  try {
    const r = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

function writePem(dir: string, prefix: string, certInfo: any) {
  const keyPath = path.join(dir, `${prefix}-key.pem`);
  const certPath = path.join(dir, `${prefix}-cert.pem`);
  fs.writeFileSync(keyPath, certInfo.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const pem =
    '-----BEGIN CERTIFICATE-----\n' +
    certInfo.certDer.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(certPath, pem);
  return { keyPath, certPath };
}

describe('DTLS interop with OpenSSL', { skip: SKIP || !hasOpenSSLDtls() }, () => {
  let tmpDir: string;
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtls-interop-'));
  });

  it('Node client completes mutual-auth handshake with openssl s_server', async () => {
    const PORT = 45100 + Math.floor(Math.random() * 200);
    const srv = x509.generateSelfSigned({ commonName: 'ossl-server' });
    const { keyPath, certPath } = writePem(tmpDir, 'srv', srv);

    const ossl = spawn(
      'openssl',
      [
        's_server', '-dtls1_2',
        '-cipher', 'ECDHE-ECDSA-AES128-GCM-SHA256',
        '-cert', certPath, '-key', keyPath,
        '-accept', String(PORT), '-Verify', '1', '-quiet',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const clientCert = x509.generateSelfSigned({ commonName: 'node-client' });
        const timer = setTimeout(() => reject(new Error('handshake timeout')), 8000);

        setTimeout(() => {
          const sock = dgram.createSocket('udp4');
          const conn = new DtlsConnection({
            role: ROLE.CLIENT,
            certDer: clientCert.certDer,
            privateKey: clientCert.privateKey,
            output: (dg: Buffer) => sock.send(dg, PORT, '127.0.0.1'),
          });
          sock.on('message', (m) => conn.handlePacket(m));
          conn.on('connect', () => conn.send(Buffer.from('ping-from-node\n')));
          conn.on('data', (d: Buffer) => {
            clearTimeout(timer);
            sock.close();
            resolve(d.toString());
          });
          conn.on('error', (e: any) => { clearTimeout(timer); reject(e); });
          conn.start();
          setTimeout(() => { try { ossl.stdin.write('pong-from-openssl\n'); } catch (_) {} }, 1000);
        }, 500);
      });
      assert.match(result, /pong-from-openssl/);
    } finally {
      ossl.kill();
    }
  });

  it('Node client completes handshake with openssl s_server that does not request a client cert', async () => {
    // No -Verify / -verify: the server sends no CertificateRequest, so the
    // client must omit its Certificate + CertificateVerify (the path taken with
    // TURN-over-DTLS servers like coturn). Exercises DtlsConnection's
    // #certRequested=false branch against real OpenSSL.
    const PORT = 45700 + Math.floor(Math.random() * 200);
    const srv = x509.generateSelfSigned({ commonName: 'ossl-server-noverify' });
    const { keyPath, certPath } = writePem(tmpDir, 'srv-nv', srv);

    const ossl = spawn(
      'openssl',
      [
        's_server', '-dtls1_2',
        '-cipher', 'ECDHE-ECDSA-AES128-GCM-SHA256',
        '-cert', certPath, '-key', keyPath,
        '-accept', String(PORT), '-quiet',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    try {
      const result = await new Promise<string>((resolve, reject) => {
        const clientCert = x509.generateSelfSigned({ commonName: 'node-client' });
        const timer = setTimeout(() => reject(new Error('handshake timeout')), 8000);

        setTimeout(() => {
          const sock = dgram.createSocket('udp4');
          const conn = new DtlsConnection({
            role: ROLE.CLIENT,
            certDer: clientCert.certDer,
            privateKey: clientCert.privateKey,
            output: (dg: Buffer) => sock.send(dg, PORT, '127.0.0.1'),
          });
          sock.on('message', (m) => conn.handlePacket(m));
          conn.on('connect', () => conn.send(Buffer.from('ping-from-node\n')));
          conn.on('data', (d: Buffer) => {
            clearTimeout(timer);
            sock.close();
            resolve(d.toString());
          });
          conn.on('error', (e: any) => { clearTimeout(timer); reject(e); });
          conn.start();
          setTimeout(() => { try { ossl.stdin.write('pong-from-openssl\n'); } catch (_) {} }, 1000);
        }, 500);
      });
      assert.match(result, /pong-from-openssl/);
    } finally {
      ossl.kill();
    }
  });

  it('Node server completes mutual-auth handshake with openssl s_client', async () => {
    const PORT = 45400 + Math.floor(Math.random() * 200);
    const srvCert = x509.generateSelfSigned({ commonName: 'node-server' });
    const cli = x509.generateSelfSigned({ commonName: 'ossl-client' });
    const { keyPath, certPath } = writePem(tmpDir, 'cli', cli);

    let ossl: any;
    const sock = dgram.createSocket('udp4');
    try {
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('handshake timeout')), 8000);
        let conn: any = null;
        sock.on('message', (msg, rinfo) => {
          if (!conn) {
            conn = new DtlsConnection({
              role: ROLE.SERVER,
              certDer: srvCert.certDer,
              privateKey: srvCert.privateKey,
              output: (dg: Buffer) => sock.send(dg, rinfo.port, rinfo.address),
            });
            conn.on('data', (d: Buffer) => {
              clearTimeout(timer);
              conn.send(Buffer.from('reply-from-node\n'));
              resolve(d.toString());
            });
            conn.on('error', (e: any) => { clearTimeout(timer); reject(e); });
            conn.start();
          }
          conn.handlePacket(msg);
        });
        sock.bind(PORT, () => {
          ossl = spawn(
            'openssl',
            ['s_client', '-dtls1_2', '-connect', `127.0.0.1:${PORT}`,
              '-cert', certPath, '-key', keyPath, '-quiet'],
            { stdio: ['pipe', 'pipe', 'pipe'] }
          );
          setTimeout(() => { try { ossl.stdin.write('hello-from-openssl\n'); } catch (_) {} }, 1200);
        });
      });
      assert.match(received, /hello-from-openssl/);
    } finally {
      if (ossl) ossl.kill();
      sock.close();
    }
  });
});
