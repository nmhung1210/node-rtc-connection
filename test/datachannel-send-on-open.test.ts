/**
 * @file datachannel-send-on-open.test.ts
 * @description Tests the RTCDataChannel transport-sender contract. Channels
 * deliver outbound data through an injected sender (set by the SCTP data
 * channel manager) rather than the legacy network-transport `_send` hook.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RTCDataChannel } from '../src/index';

describe('Data Channel sender contract', () => {
  it('invokes the sender with (Buffer, isBinary=false) for strings', () => {
    const channel = new RTCDataChannel('test');
    let captured: any = null;
    RTCDataChannel.control(channel).setSender((data: any, isBinary: any) => { captured = { data, isBinary }; });
    RTCDataChannel.control(channel).open();

    channel.send('hello');
    assert.ok(Buffer.isBuffer(captured.data));
    assert.strictEqual(captured.data.toString(), 'hello');
    assert.strictEqual(captured.isBinary, false);
  });

  it('invokes the sender with isBinary=true for ArrayBuffer/typed arrays', () => {
    const channel = new RTCDataChannel('test');
    let captured: any = null;
    RTCDataChannel.control(channel).setSender((data: any, isBinary: any) => { captured = { data, isBinary }; });
    RTCDataChannel.control(channel).open();

    channel.send(Uint8Array.from([1, 2, 3]).buffer);
    assert.ok(Buffer.isBuffer(captured.data));
    assert.deepStrictEqual([...captured.data], [1, 2, 3]);
    assert.strictEqual(captured.isBinary, true);
  });

  it('throws if send() is called before a sender is attached', () => {
    const channel = new RTCDataChannel('test');
    RTCDataChannel.control(channel).open();
    assert.throws(() => channel.send('x'), /not connected to a transport/);
  });

  it('throws if send() is called while not open', () => {
    const channel = new RTCDataChannel('test');
    RTCDataChannel.control(channel).setSender(() => {});
    assert.throws(() => channel.send('x'), /readyState is not "open"/);
  });

  it('decrements bufferedAmount after the sender accepts the data', () => {
    const channel = new RTCDataChannel('test');
    RTCDataChannel.control(channel).setSender(() => {});
    RTCDataChannel.control(channel).open();
    channel.send('abcde');
    assert.strictEqual(channel.bufferedAmount, 0);
  });
});
