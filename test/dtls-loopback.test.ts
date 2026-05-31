/**
 * @file dtls-loopback.test.ts
 * @description DTLS client<->server handshake over an in-memory channel.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DtlsConnection, ROLE } from '../src/dtls/connection';
import * as x509 from '../src/crypto/x509';

function makePeer(role: any, output: any, certInfo: any) {
  return new DtlsConnection({
    role,
    certDer: certInfo.certDer,
    privateKey: certInfo.privateKey,
    output,
  });
}

describe('DTLS loopback handshake', () => {
  it('completes a full ECDHE_ECDSA handshake and exchanges app data', async () => {
    const clientCert = x509.generateSelfSigned({ commonName: 'client' });
    const serverCert = x509.generateSelfSigned({ commonName: 'server' });

    let client: any, server: any;
    // Wire the two connections together with async delivery.
    const deliver = (to: any) => (datagram: any) => {
      const copy = Buffer.from(datagram);
      setImmediate(() => to().handlePacket(copy));
    };
    client = makePeer(ROLE.CLIENT, deliver(() => server), clientCert);
    server = makePeer(ROLE.SERVER, deliver(() => client), serverCert);

    const connected = Promise.all([
      new Promise((res, rej) => { client.on('connect', res); client.on('error', rej); }),
      new Promise((res, rej) => { server.on('connect', res); server.on('error', rej); }),
    ]);

    server.start(); // server just waits
    client.start(); // client drives the handshake

    await connected;

    assert.strictEqual(client.state, 'connected');
    assert.strictEqual(server.state, 'connected');

    // Each side should have learned the other's certificate.
    assert.ok(server.getRemoteCertificate().equals(clientCert.certDer));
    assert.ok(client.getRemoteCertificate().equals(serverCert.certDer));

    // Application data both directions.
    const gotOnServer = new Promise<any>((res) => server.on('data', res));
    const gotOnClient = new Promise<any>((res) => client.on('data', res));

    client.send(Buffer.from('hello-from-client'));
    server.send(Buffer.from('hello-from-server'));

    assert.strictEqual((await gotOnServer).toString(), 'hello-from-client');
    assert.strictEqual((await gotOnClient).toString(), 'hello-from-server');
  });

  it('rejects when fingerprint verification fails', async () => {
    const clientCert = x509.generateSelfSigned({ commonName: 'client' });
    const serverCert = x509.generateSelfSigned({ commonName: 'server' });

    let client: any, server: any;
    const deliver = (to: any) => (d: any) => { const c = Buffer.from(d); setImmediate(() => to().handlePacket(c)); };

    client = new DtlsConnection({
      role: ROLE.CLIENT, certDer: clientCert.certDer, privateKey: clientCert.privateKey,
      output: deliver(() => server),
      verifyFingerprint: () => false, // reject the server cert
    });
    server = makePeer(ROLE.SERVER, deliver(() => client), serverCert);

    const failed = new Promise<any>((res) => client.on('error', res));
    server.start();
    client.start();

    const err = await failed;
    assert.match(err.message, /fingerprint/i);
  });
});
