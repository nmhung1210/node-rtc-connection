/**
 * @file sctp-loopback.test.js
 * @description SCTP association + DCEP over an in-memory datagram pipe.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SctpAssociation } = require('../src/sctp/association');
const dcep = require('../src/sctp/dcep');
const { PPID } = require('../src/sctp/chunks');
const { verifyChecksum } = require('../src/sctp/crc32c');

function wire(a, b) {
  a.on('output', (pkt) => { const c = Buffer.from(pkt); setImmediate(() => b.receivePacket(c)); });
  b.on('output', (pkt) => { const c = Buffer.from(pkt); setImmediate(() => a.receivePacket(c)); });
}

/** Create a wired, established client/server pair. */
async function establishedPair() {
  const client = new SctpAssociation({ isClient: true });
  const server = new SctpAssociation({ isClient: false });
  wire(client, server);
  const up = Promise.all([
    new Promise((r) => client.on('established', r)),
    new Promise((r) => server.on('established', r)),
  ]);
  server.start();
  client.start();
  await up;
  return { client, server };
}

describe('SCTP association', () => {
  it('completes the 4-way setup handshake', async () => {
    const { client, server } = await establishedPair();
    assert.strictEqual(client.state, 'established');
    assert.strictEqual(server.state, 'established');
  });

  it('delivers a small message', async () => {
    const { client, server } = await establishedPair();
    const gotS = new Promise((r) => server.on('message', r));
    client.sendData(1, PPID.STRING, Buffer.from('hello-sctp'));
    const msg = await gotS;
    assert.strictEqual(msg.streamId, 1);
    assert.strictEqual(msg.ppid, PPID.STRING);
    assert.strictEqual(msg.data.toString(), 'hello-sctp');
  });

  it('fragments and reassembles a large message', async () => {
    const { client, server } = await establishedPair();
    const big = Buffer.alloc(5000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const gotS = new Promise((r) => server.on('message', r));
    client.sendData(3, PPID.BINARY, big);
    const msg = await gotS;
    assert.strictEqual(msg.data.length, 5000);
    assert.ok(msg.data.equals(big));
  });

  it('carries a DCEP open/ack exchange', async () => {
    const { client, server } = await establishedPair();
    server.on('message', (m) => {
      if (m.ppid === PPID.DCEP && dcep.messageType(m.data) === dcep.MESSAGE_TYPE.DATA_CHANNEL_OPEN) {
        server.sendData(m.streamId, PPID.DCEP, dcep.encodeAck());
      }
    });
    const ackSeen = new Promise((r) => {
      client.on('message', (m) => {
        if (m.ppid === PPID.DCEP && dcep.messageType(m.data) === dcep.MESSAGE_TYPE.DATA_CHANNEL_ACK) r(m);
      });
    });
    const open = dcep.encodeOpen({ channelType: dcep.CHANNEL_TYPE.RELIABLE, label: 'chat', protocol: '' });
    client.sendData(0, PPID.DCEP, open);
    const ack = await ackSeen;
    assert.strictEqual(ack.streamId, 0);
  });

  it('produces packets with valid CRC32c checksums', async () => {
    const client = new SctpAssociation({ isClient: true });
    let firstPacket = null;
    client.on('output', (p) => { if (!firstPacket) firstPacket = Buffer.from(p); });
    client.start();
    await new Promise((r) => setImmediate(r));
    assert.ok(firstPacket);
    assert.ok(verifyChecksum(firstPacket));
  });
});
