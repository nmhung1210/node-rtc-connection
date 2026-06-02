/**
 * @file sctp-loopback.test.ts
 * @description SCTP association + DCEP over an in-memory datagram pipe.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SctpAssociation } from '../src/sctp/association';
import * as dcep from '../src/sctp/dcep';
import * as C from '../src/sctp/chunks';
import { PPID } from '../src/sctp/chunks';
import { verifyChecksum, applyChecksum } from '../src/sctp/crc32c';

function wire(a: any, b: any) {
  a.on('output', (pkt: any) => { const c = Buffer.from(pkt); setImmediate(() => b.receivePacket(c)); });
  b.on('output', (pkt: any) => { const c = Buffer.from(pkt); setImmediate(() => a.receivePacket(c)); });
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
    const gotS = new Promise<any>((r) => server.on('message', r));
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
    const gotS = new Promise<any>((r) => server.on('message', r));
    client.sendData(3, PPID.BINARY, big);
    const msg = await gotS;
    assert.strictEqual(msg.data.length, 5000);
    assert.ok(msg.data.equals(big));
  });

  it('carries a DCEP open/ack exchange', async () => {
    const { client, server } = await establishedPair();
    server.on('message', (m: any) => {
      if (m.ppid === PPID.DCEP && dcep.messageType(m.data) === dcep.MESSAGE_TYPE.DATA_CHANNEL_OPEN) {
        server.sendData(m.streamId, PPID.DCEP, dcep.encodeAck());
      }
    });
    const ackSeen = new Promise<any>((r) => {
      client.on('message', (m: any) => {
        if (m.ppid === PPID.DCEP && dcep.messageType(m.data) === dcep.MESSAGE_TYPE.DATA_CHANNEL_ACK) r(m);
      });
    });
    const open = dcep.encodeOpen({ channelType: dcep.CHANNEL_TYPE.RELIABLE, label: 'chat', protocol: '' });
    client.sendData(0, PPID.DCEP, open);
    const ack = await ackSeen;
    assert.strictEqual(ack.streamId, 0);
  });

  it('sends a SACK without overflowing the 16-bit gap-ack field for a far-ahead TSN', async () => {
    // Regression: a gap-ack offset is a uint16 relative to the cumulative TSN
    // ack. A reordered/large-gap DATA chunk (as seen over a TURN relay) once
    // produced offset 65536 and crashed the SACK encoder. Feed the server an
    // out-of-order DATA chunk whose TSN sits >0xffff ahead and assert it SACKs
    // cleanly (the oversized gap block is skipped, not written).
    const { client, server } = await establishedPair();

    // Capture the verification tag + ports the client uses toward the server by
    // observing a normal DATA packet, and wait until the server has delivered it
    // so its cumulative TSN ack equals that DATA's TSN.
    const outbound = new Promise<Buffer>((r) => client.once('output', (p: any) => r(Buffer.from(p))));
    const seedDelivered = new Promise<void>((r) => server.once('message', () => r()));
    client.sendData(1, PPID.STRING, Buffer.from('seed'));
    const sample = await outbound;
    await seedDelivered;

    const header = C.parseCommonHeader(sample);
    const seedTsn = C.parseChunks(sample).find((c: any) => c.type === C.CHUNK_TYPE.DATA)!.body.readUInt32BE(0);
    // Offset of exactly 0x10000 past the cumulative ack: the old code computed
    // ((tsn - base) & 0xffff) + 1 = 65535 + 1 = 65536, overflowing the field.
    const farTsn = (seedTsn + 0x10000) >>> 0;
    const { flags, body } = C.encodeDataBody({
      tsn: farTsn, streamId: 1, streamSeq: 5, ppid: PPID.STRING, userData: Buffer.from('far'),
    });
    const dataChunk = C.encodeChunk(C.CHUNK_TYPE.DATA, flags, body);
    const packet = Buffer.concat([
      C.encodeCommonHeader(header.dstPort, header.srcPort, header.verificationTag),
      dataChunk,
    ]);
    applyChecksum(packet);

    const sackOut = new Promise<Buffer>((r) => server.once('output', (p: any) => r(Buffer.from(p))));
    // Must not throw (previously RangeError in encodeSackBody).
    assert.doesNotThrow(() => server.receivePacket(packet));
    const sack = await sackOut;
    assert.ok(verifyChecksum(sack), 'server SACK should have a valid checksum');
  });

  it('produces packets with valid CRC32c checksums', async () => {
    const client = new SctpAssociation({ isClient: true });
    let firstPacket: Buffer | null = null;
    client.on('output', (p: any) => { if (!firstPacket) firstPacket = Buffer.from(p); });
    client.start();
    await new Promise((r) => setImmediate(r));
    assert.ok(firstPacket);
    assert.ok(verifyChecksum(firstPacket));
  });
});
