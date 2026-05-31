/**
 * @file datachannel-send-on-open.test.ts
 * @description Tests the RTCDataChannel transport contract. A channel delivers
 * outbound data by emitting the internal SEND event (which the SCTP data
 * channel manager listens for), and the transport drives the channel via the
 * internal OPEN / SET_ID / RECEIVE events.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RTCDataChannel, RTCDataChannelEvents } from '../src/datachannel/RTCDataChannel';

describe('Data Channel transport contract', () => {
  it('emits SEND with (Buffer, isBinary=false) for strings', () => {
    const channel = new RTCDataChannel('test');
    const sent: Array<{ data: Buffer; isBinary: boolean }> = [];
    channel.on(RTCDataChannelEvents.SEND, (data: Buffer, isBinary: boolean) => { sent.push({ data, isBinary }); });
    channel.emit(RTCDataChannelEvents.OPEN);

    channel.send('hello');
    assert.strictEqual(sent.length, 1);
    assert.ok(Buffer.isBuffer(sent[0]!.data));
    assert.strictEqual(sent[0]!.data.toString(), 'hello');
    assert.strictEqual(sent[0]!.isBinary, false);
  });

  it('emits SEND with isBinary=true for ArrayBuffer/typed arrays', () => {
    const channel = new RTCDataChannel('test');
    const sent: Array<{ data: Buffer; isBinary: boolean }> = [];
    channel.on(RTCDataChannelEvents.SEND, (data: Buffer, isBinary: boolean) => { sent.push({ data, isBinary }); });
    channel.emit(RTCDataChannelEvents.OPEN);

    channel.send(Uint8Array.from([1, 2, 3]).buffer);
    assert.strictEqual(sent.length, 1);
    assert.ok(Buffer.isBuffer(sent[0]!.data));
    assert.deepStrictEqual([...sent[0]!.data], [1, 2, 3]);
    assert.strictEqual(sent[0]!.isBinary, true);
  });

  it('throws if send() is called while not open', () => {
    const channel = new RTCDataChannel('test');
    channel.on(RTCDataChannelEvents.SEND, () => {});
    assert.throws(() => channel.send('x'), /readyState is not "open"/);
  });

  it('decrements bufferedAmount after the transport takes the data', () => {
    const channel = new RTCDataChannel('test');
    channel.on(RTCDataChannelEvents.SEND, () => {});
    channel.emit(RTCDataChannelEvents.OPEN);
    channel.send('abcde');
    assert.strictEqual(channel.bufferedAmount, 0);
  });

  it('fires the public open event and assigns the id from transport events', () => {
    const channel = new RTCDataChannel('test');
    let opened = false;
    channel.on('open', () => { opened = true; });
    channel.emit(RTCDataChannelEvents.SET_ID, 7);
    channel.emit(RTCDataChannelEvents.OPEN);
    assert.strictEqual(channel.id, 7);
    assert.strictEqual(channel.readyState, 'open');
    assert.strictEqual(opened, true);
  });
});
