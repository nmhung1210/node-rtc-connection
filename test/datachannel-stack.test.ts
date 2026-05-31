/**
 * @file datachannel-stack.test.ts
 * @description SCTP + DCEP manager + RTCDataChannel end-to-end over a pipe.
 * Verifies channel open via DCEP and correct string/binary round-tripping
 * (the binary path was previously corrupted by JSON serialization).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SctpAssociation } from '../src/sctp/association';
import { DataChannelManager } from '../src/sctp/datachannel-manager';
import { RTCDataChannel } from '../src/datachannel/RTCDataChannel';

function wire(a: any, b: any) {
  a.on('output', (pkt: any) => { const c = Buffer.from(pkt); setImmediate(() => b.receivePacket(c)); });
  b.on('output', (pkt: any) => { const c = Buffer.from(pkt); setImmediate(() => a.receivePacket(c)); });
}

async function setup() {
  const clientSctp = new SctpAssociation({ isClient: true });
  const serverSctp = new SctpAssociation({ isClient: false });
  wire(clientSctp, serverSctp);

  const clientMgr = new DataChannelManager(clientSctp, true);
  const serverMgr = new DataChannelManager(serverSctp, false);

  const up = Promise.all([
    new Promise((r) => clientSctp.on('established', r)),
    new Promise((r) => serverSctp.on('established', r)),
  ]);
  serverSctp.start();
  clientSctp.start();
  await up;

  return { clientMgr, serverMgr };
}

describe('Data channel stack', () => {
  it('opens a channel via DCEP and fires open on both ends', async () => {
    const { clientMgr, serverMgr } = await setup();

    const serverChannelP = new Promise<any>((resolve) => {
      serverMgr.on('open-request', (info: any) => {
        const ch = new RTCDataChannel(info.label, { ordered: info.ordered });
        serverMgr.acceptChannel(ch, info);
        resolve(ch);
      });
    });

    const local = new RTCDataChannel('chat', { ordered: true });
    const localOpen = new Promise((r) => local.on('open', r));
    clientMgr.openChannel(local, { ordered: true });

    await localOpen;
    const remote = await serverChannelP;

    assert.strictEqual(local.readyState, 'open');
    assert.strictEqual(remote.label, 'chat');
  });

  it('round-trips string messages', async () => {
    const { clientMgr, serverMgr } = await setup();
    const remoteP = new Promise<any>((resolve) => {
      serverMgr.on('open-request', (info: any) => {
        const ch = new RTCDataChannel(info.label, { ordered: info.ordered });
        serverMgr.acceptChannel(ch, info);
        resolve(ch);
      });
    });
    const local = new RTCDataChannel('chat', { ordered: true });
    const localOpen = new Promise((r) => local.on('open', r));
    clientMgr.openChannel(local, { ordered: true });
    await localOpen;
    const remote = await remoteP;

    const got = new Promise((r) => remote.on('message', (e: any) => r(e.data)));
    local.send('hello world');
    const data = await got;
    assert.strictEqual(typeof data, 'string');
    assert.strictEqual(data, 'hello world');
  });

  it('round-trips binary messages without corruption', async () => {
    const { clientMgr, serverMgr } = await setup();
    const remoteP = new Promise<any>((resolve) => {
      serverMgr.on('open-request', (info: any) => {
        const ch = new RTCDataChannel(info.label, { ordered: info.ordered });
        ch.binaryType = 'arraybuffer';
        serverMgr.acceptChannel(ch, info);
        resolve(ch);
      });
    });
    const local = new RTCDataChannel('bin', { ordered: true });
    const localOpen = new Promise((r) => local.on('open', r));
    clientMgr.openChannel(local, { ordered: true });
    await localOpen;
    const remote = await remoteP;

    const original = Uint8Array.from([0, 1, 2, 254, 255, 128, 42]);
    const got = new Promise<any>((r) => remote.on('message', (e: any) => r(e.data)));
    local.send(original.buffer);

    const data = await got;
    assert.ok(data instanceof ArrayBuffer, 'binary should arrive as ArrayBuffer');
    assert.deepStrictEqual(new Uint8Array(data), original);
  });
});
