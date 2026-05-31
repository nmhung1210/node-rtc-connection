/**
 * @file datachannel-send-on-open.test.js
 * @description Tests the RTCDataChannel transport-sender contract. Channels
 * deliver outbound data through an injected sender (set by the SCTP data
 * channel manager) rather than the legacy network-transport `_send` hook.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCDataChannel } = require('../src/index');

describe('Data Channel sender contract', () => {
  it('invokes the sender with (Buffer, isBinary=false) for strings', () => {
    const channel = new RTCDataChannel('test');
    let captured = null;
    channel._setSender((data, isBinary) => { captured = { data, isBinary }; });
    channel._setStateToOpen();

    channel.send('hello');
    assert.ok(Buffer.isBuffer(captured.data));
    assert.strictEqual(captured.data.toString(), 'hello');
    assert.strictEqual(captured.isBinary, false);
  });

  it('invokes the sender with isBinary=true for ArrayBuffer/typed arrays', () => {
    const channel = new RTCDataChannel('test');
    let captured = null;
    channel._setSender((data, isBinary) => { captured = { data, isBinary }; });
    channel._setStateToOpen();

    channel.send(Uint8Array.from([1, 2, 3]).buffer);
    assert.ok(Buffer.isBuffer(captured.data));
    assert.deepStrictEqual([...captured.data], [1, 2, 3]);
    assert.strictEqual(captured.isBinary, true);
  });

  it('throws if send() is called before a sender is attached', () => {
    const channel = new RTCDataChannel('test');
    channel._setStateToOpen();
    assert.throws(() => channel.send('x'), /not connected to a transport/);
  });

  it('throws if send() is called while not open', () => {
    const channel = new RTCDataChannel('test');
    channel._setSender(() => {});
    assert.throws(() => channel.send('x'), /readyState is not "open"/);
  });

  it('decrements bufferedAmount after the sender accepts the data', () => {
    const channel = new RTCDataChannel('test');
    channel._setSender(() => {});
    channel._setStateToOpen();
    channel.send('abcde');
    assert.strictEqual(channel.bufferedAmount, 0);
  });
});
