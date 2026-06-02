/**
 * @file teardown-leaks.test.ts
 * @description Regression tests for the teardown/memory-leak fixes: closed
 * data channels must shed their internal listeners, the DataChannelManager
 * must drop channels and detach its SCTP listener on close, and a closed SCTP
 * association must release its retransmit/reassembly/gap buffers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SctpAssociation } from '../src/sctp/association';
import { DataChannelManager } from '../src/sctp/datachannel-manager';
import { RTCDataChannel, RTCDataChannelEvents } from '../src/datachannel/RTCDataChannel';

const flush = () => new Promise((r) => setImmediate(r));

describe('teardown / leak prevention', () => {
  it('detaches a channel\'s internal transport listeners when it closes', async () => {
    const ch = new RTCDataChannel('x', { negotiated: true, id: 0 });
    assert.equal(ch.listenerCount(RTCDataChannelEvents.RECEIVE), 1);
    assert.equal(ch.listenerCount(RTCDataChannelEvents.OPEN), 1);
    assert.equal(ch.listenerCount(RTCDataChannelEvents.SET_ID), 1);

    ch.close();
    await flush();

    assert.equal(ch.readyState, 'closed');
    assert.equal(ch.listenerCount(RTCDataChannelEvents.RECEIVE), 0, 'RECEIVE detached');
    assert.equal(ch.listenerCount(RTCDataChannelEvents.OPEN), 0, 'OPEN detached');
    assert.equal(ch.listenerCount(RTCDataChannelEvents.SET_ID), 0, 'SET_ID detached');
  });

  it('DataChannelManager drops channels + listeners as they close (churn)', async () => {
    const sctp = new SctpAssociation({ isClient: true });
    const dcm = new DataChannelManager(sctp, true);
    assert.equal(sctp.listenerCount('message'), 1, 'manager attached one message listener');

    // Open and close many negotiated channels; none should leave listeners
    // behind on close.
    for (let i = 0; i < 200; i++) {
      const ch = new RTCDataChannel('c' + i, { negotiated: true, id: i * 2 });
      dcm.openChannel(ch, {});
      assert.equal(ch.listenerCount(RTCDataChannelEvents.SEND), 1);
      assert.equal(ch.listenerCount(RTCDataChannelEvents.CLOSE), 1);
      ch.close();
      await flush();
      assert.equal(ch.listenerCount(RTCDataChannelEvents.SEND), 0, 'SEND detached on close');
      assert.equal(ch.listenerCount(RTCDataChannelEvents.CLOSE), 0, 'CLOSE detached on close');
    }

    dcm.close();
    assert.equal(sctp.listenerCount('message'), 0, 'manager detached its SCTP listener on close');
  });

  it('SCTP association closes cleanly after buffering sent data', async () => {
    const a = new SctpAssociation({ isClient: true });
    const b = new SctpAssociation({ isClient: false });
    a.on('output', (pkt: Buffer) => setImmediate(() => b.receivePacket(Buffer.from(pkt))));
    b.on('output', (pkt: Buffer) => setImmediate(() => a.receivePacket(Buffer.from(pkt))));
    // The association emits 'error' on abort; absorb it so the test doesn't
    // throw on the unhandled event.
    a.on('error', () => {});
    b.on('error', () => {});

    const up = Promise.all([
      new Promise((r) => a.on('established', r)),
      new Promise((r) => b.on('established', r)),
    ]);
    b.start();
    a.start();
    await up;

    // Queue outbound data so the retransmit queue is non-empty, then close.
    // #releaseBuffers() (covered indirectly) clears the retransmit/reassembly/
    // gap maps; here we assert the close path runs cleanly and is idempotent.
    a.sendData(0, 51, Buffer.from('hello'));
    a.shutdown();
    assert.equal(a.state, 'closed');
    a.shutdown(); // idempotent, must not throw
    assert.equal(a.state, 'closed');
  });
});
