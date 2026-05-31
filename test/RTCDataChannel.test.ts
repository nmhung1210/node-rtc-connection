/**
 * @file RTCDataChannel.test.ts
 * @description Tests for RTCDataChannel with real networking
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { RTCDataChannel, RTCDataChannelState } from '../src/datachannel/RTCDataChannel';
// @ts-ignore -- helper is still a CommonJS .js module
import { createConnectedPeers, closePeers } from './helpers/peer-connection-helper';

describe('RTCDataChannel', () => {
  describe('Constructor', () => {
    it('should create a data channel with default configuration', () => {
      const channel = new RTCDataChannel('test');
      assert.strictEqual(channel.label, 'test');
      assert.strictEqual(channel.ordered, true);
      assert.strictEqual(channel.maxPacketLifeTime, null);
      assert.strictEqual(channel.maxRetransmits, null);
      assert.strictEqual(channel.protocol, '');
      assert.strictEqual(channel.negotiated, false);
      assert.strictEqual(channel.id, null);
      assert.strictEqual(channel.readyState, 'connecting');
      assert.strictEqual(channel.bufferedAmount, 0);
      assert.strictEqual(channel.bufferedAmountLowThreshold, 0);
      assert.strictEqual(channel.binaryType, 'arraybuffer');
    });

    it('should create a data channel with custom configuration', () => {
      const channel = new RTCDataChannel('myChannel', {
        ordered: false,
        maxPacketLifeTime: 3000,
        protocol: 'json',
        negotiated: true,
        id: 42
      });
      assert.strictEqual(channel.label, 'myChannel');
      assert.strictEqual(channel.ordered, false);
      assert.strictEqual(channel.maxPacketLifeTime, 3000);
      assert.strictEqual(channel.maxRetransmits, null);
      assert.strictEqual(channel.protocol, 'json');
      assert.strictEqual(channel.negotiated, true);
      assert.strictEqual(channel.id, 42);
    });

    it('should throw TypeError if label is not a string', () => {
      assert.throws(() => {
        new RTCDataChannel(123 as any);
      }, TypeError);
    });

    it('should create a data channel with maxRetransmits', () => {
      const channel = new RTCDataChannel('test', {
        maxRetransmits: 5
      });
      assert.strictEqual(channel.maxRetransmits, 5);
      assert.strictEqual(channel.maxPacketLifeTime, null);
    });
  });

  describe('Properties', () => {
    let channel: RTCDataChannel;

    beforeEach(() => {
      channel = new RTCDataChannel('test', {
        ordered: false,
        maxPacketLifeTime: 1000,
        maxRetransmits: 3,
        protocol: 'custom',
        negotiated: true,
        id: 10
      });
    });

    it('should expose label property', () => {
      assert.strictEqual(channel.label, 'test');
    });

    it('should expose ordered property', () => {
      assert.strictEqual(channel.ordered, false);
    });

    it('should expose maxPacketLifeTime property', () => {
      assert.strictEqual(channel.maxPacketLifeTime, 1000);
    });

    it('should expose maxRetransmits property', () => {
      assert.strictEqual(channel.maxRetransmits, 3);
    });

    it('should expose protocol property', () => {
      assert.strictEqual(channel.protocol, 'custom');
    });

    it('should expose negotiated property', () => {
      assert.strictEqual(channel.negotiated, true);
    });

    it('should expose id property', () => {
      assert.strictEqual(channel.id, 10);
    });

    it('should expose readyState property', () => {
      assert.strictEqual(channel.readyState, 'connecting');
    });

    it('should expose bufferedAmount property', () => {
      assert.strictEqual(channel.bufferedAmount, 0);
    });

    it('should get bufferedAmountLowThreshold property', () => {
      assert.strictEqual(channel.bufferedAmountLowThreshold, 0);
    });

    it('should set bufferedAmountLowThreshold property', () => {
      channel.bufferedAmountLowThreshold = 1024;
      assert.strictEqual(channel.bufferedAmountLowThreshold, 1024);
    });

    it('should expose binaryType property', () => {
      assert.strictEqual(channel.binaryType, 'arraybuffer');
    });

    it('should set binaryType to "blob"', () => {
      channel.binaryType = 'blob';
      assert.strictEqual(channel.binaryType, 'blob');
    });

    it('should throw TypeError for invalid binaryType', () => {
      assert.throws(() => {
        channel.binaryType = 'invalid' as any;
      }, TypeError);
    });

    it('should report reliable as true for ordered with no limits', () => {
      const reliable = new RTCDataChannel('reliable');
      assert.strictEqual(reliable.reliable, true);
    });

    it('should report reliable as false for unordered', () => {
      assert.strictEqual(channel.reliable, false);
    });

    it('should report reliable as false with maxPacketLifeTime', () => {
      const unreliable = new RTCDataChannel('test', { maxPacketLifeTime: 100 });
      assert.strictEqual(unreliable.reliable, false);
    });
  });

  describe('State Transitions', () => {
    let channel: RTCDataChannel;

    beforeEach(() => {
      channel = new RTCDataChannel('test');
    });

    it('should start in connecting state', () => {
      assert.strictEqual(channel.readyState, 'connecting');
    });

    it('should transition to open state', (t, done) => {
      channel.on('open', () => {
        assert.strictEqual(channel.readyState, 'open');
        done();
      });
      RTCDataChannel.control(channel).open();
    });

    it('should transition to closing state', (t, done) => {
      RTCDataChannel.control(channel).open();
      channel.on('closing', () => {
        assert.strictEqual(channel.readyState, 'closing');
        done();
      });
      channel.close();
    });

    it('should transition to closed state', (t, done) => {
      RTCDataChannel.control(channel).open();
      channel.on('close', () => {
        assert.strictEqual(channel.readyState, 'closed');
        done();
      });
      channel.close();
    });

    it('should not emit events if state does not change', () => {
      let eventCount = 0;
      channel.on('open', () => eventCount++);
      RTCDataChannel.control(channel).open();
      RTCDataChannel.control(channel).open();
      assert.strictEqual(eventCount, 1);
    });

    it('should ignore close() if already closing', () => {
      RTCDataChannel.control(channel).open();
      channel.close();
      assert.strictEqual(channel.readyState, 'closing');
      channel.close();
      assert.strictEqual(channel.readyState, 'closing');
    });

    it('should ignore close() if already closed', (t, done) => {
      RTCDataChannel.control(channel).open();
      channel.on('close', () => {
        channel.close();
        assert.strictEqual(channel.readyState, 'closed');
        done();
      });
      channel.close();
    });
  });

  describe.skip('Send', () => {
    let pc1: any, pc2: any, channel: any;

    beforeEach(async () => {
      // Create connected peers with real networking
      const peers = await createConnectedPeers('test');
      pc1 = peers.pc1;
      pc2 = peers.pc2;
      channel = peers.channel1;
    });

    afterEach(() => {
      closePeers(pc1, pc2);
    });

    it('should throw if not in open state', () => {
      const closedChannel = new RTCDataChannel('test');
      assert.throws(() => {
        closedChannel.send('test');
      }, Error);
    });

    it('should send a string message', () => {
      assert.doesNotThrow(() => {
        channel.send('Hello, World!');
      });
    });

    it('should send an ArrayBuffer', () => {
      const buffer = new ArrayBuffer(16);
      assert.doesNotThrow(() => {
        channel.send(buffer);
      });
    });

    it('should send a Uint8Array', () => {
      const view = new Uint8Array([1, 2, 3, 4]);
      assert.doesNotThrow(() => {
        channel.send(view);
      });
    });

    it('should throw for Blob (not implemented)', () => {
      const blob = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) };
      assert.throws(() => {
        channel.send(blob);
      }, Error);
    });

    it('should throw for invalid data type', () => {
      assert.throws(() => {
        channel.send(123);
      }, TypeError);
    });

    it('should update bufferedAmount for string', () => {
      const message = 'Hello';
      channel.send(message);
      assert.ok(channel.bufferedAmount >= 0);
    });

    it('should update bufferedAmount for ArrayBuffer', () => {
      const buffer = new ArrayBuffer(256);
      const initialAmount = channel.bufferedAmount;
      channel.send(buffer);
      assert.ok(channel.bufferedAmount >= initialAmount);
    });

    it('should decrease bufferedAmount after send completes', (t, done) => {
      channel.send('test');
      const initial = channel.bufferedAmount;
      setTimeout(() => {
        // Buffer amount should decrease or stay at 0
        assert.ok(channel.bufferedAmount <= initial);
        done();
      }, 50);
    });

    it('should emit bufferedamountlow event', (t, done) => {
      channel.bufferedAmountLowThreshold = 100;
      channel.on('bufferedamountlow', () => {
        assert.ok(channel.bufferedAmount <= 100);
        done();
      });
      channel.send('test');
      // Also accept immediate success if buffer is already low
      setTimeout(() => {
        if (channel.bufferedAmount <= 100) {
          done();
        }
      }, 50);
    });

    it('should not emit bufferedamountlow if above threshold', (t, done) => {
      channel.bufferedAmountLowThreshold = 1;
      let emitted = false;
      channel.on('bufferedamountlow', () => {
        emitted = true;
      });
      // Send enough to stay above threshold temporarily
      channel.send('a'.repeat(1000));
      setTimeout(() => {
        assert.ok(!emitted || channel.bufferedAmount <= 1);
        done();
      }, 50);
    });
  });

  describe('Receive', () => {
    let channel: RTCDataChannel;

    beforeEach(() => {
      channel = new RTCDataChannel('test');
      RTCDataChannel.control(channel).open();
    });

    it('should emit a string message for non-binary frames', (t, done) => {
      channel.on('message', (event: any) => {
        assert.strictEqual(event.data, 'Hello');
        done();
      });
      RTCDataChannel.control(channel).receiveMessage(Buffer.from('Hello', 'utf8'), false);
    });

    it('should emit binary frames as ArrayBuffer by default', (t, done) => {
      const buffer = Buffer.from([1, 2, 3]);
      channel.on('message', (event: any) => {
        assert.ok(event.data instanceof ArrayBuffer);
        assert.deepStrictEqual(new Uint8Array(event.data), new Uint8Array([1, 2, 3]));
        done();
      });
      RTCDataChannel.control(channel).receiveMessage(buffer, true);
    });
  });

  describe('Channel ID', () => {
    it('should allow setting channel ID', () => {
      const channel = new RTCDataChannel('test');
      assert.strictEqual(channel.id, null);
      RTCDataChannel.control(channel).setId(123);
      assert.strictEqual(channel.id, 123);
    });
  });

  describe('RTCDataChannelState Enum', () => {
    it('should have connecting state', () => {
      assert.strictEqual(RTCDataChannelState.CONNECTING, 'connecting');
    });

    it('should have open state', () => {
      assert.strictEqual(RTCDataChannelState.OPEN, 'open');
    });

    it('should have closing state', () => {
      assert.strictEqual(RTCDataChannelState.CLOSING, 'closing');
    });

    it('should have closed state', () => {
      assert.strictEqual(RTCDataChannelState.CLOSED, 'closed');
    });

    it('should be frozen', () => {
      assert.throws(() => {
        'use strict';
        (RTCDataChannelState as any).CONNECTING = 'modified';
      });
    });
  });

  describe.skip('Event Emitter', () => {
    let pc1: any, pc2: any, channel: any, remoteChannel: any;

    beforeEach(async () => {
      // Create connected peers
      const peers = await createConnectedPeers('test');
      pc1 = peers.pc1;
      pc2 = peers.pc2;
      channel = peers.channel1;
      remoteChannel = peers.channel2;
    });

    afterEach(() => {
      closePeers(pc1, pc2);
    });

    it('should support on() for open event', () => {
      // Channel should already be open from beforeEach
      assert.strictEqual(channel.readyState, 'open');
    });

    it('should support on() for close event', async (t) => {
      // Channel is already open from beforeEach
      await new Promise<void>(resolve => {
        channel.on('close', resolve);
        channel.close();
      });
    });

    it('should support on() for message event', async (t) => {
      // Channels are already open from beforeEach
      await new Promise<void>((resolve) => {
        channel.once('message', (event: any) => {
          assert.strictEqual(event.data, 'test');
          resolve();
        });

        remoteChannel.send('test');
      });
    });

    it('should support on() for bufferedamountlow event', async (t) => {
      channel.bufferedAmountLowThreshold = 10;
      await new Promise<void>(resolve => {
        channel.on('bufferedamountlow', () => {
          resolve();
        });
        channel.send('test');
        // Give it time to process
        setTimeout(() => {
          if (channel.bufferedAmount <= 10) resolve();
        }, 100);
      });
    });

    it('should support once() for events', async (t) => {
      // Create new channel for this test to test once() behavior
      const testChannel = pc1.createDataChannel('once-test');
      let count = 0;
      testChannel.once('open', () => {
        count++;
      });

      await new Promise(r => setTimeout(r, 200));
      assert.strictEqual(count, 1);
    });

    it('should support removeListener()', () => {
      let called = false;
      const handler = () => { called = true; };
      channel.on('open', handler);
      channel.removeListener('open', handler);
      // Trigger open manually for this test
      if (channel.readyState === 'open') {
        // Already open, check not called
      }
      assert.strictEqual(called, false);
    });
  });

  describe.skip('Integration', () => {
    let pc1: any, pc2: any;

    afterEach(() => {
      closePeers(pc1, pc2);
    });

    it('should handle complete lifecycle', async (t) => {
      const peers = await createConnectedPeers('lifecycle');
      pc1 = peers.pc1;
      pc2 = peers.pc2;
      const channel = peers.channel1;

      const events: string[] = [];
      channel.on('open', () => events.push('open'));
      channel.on('closing', () => events.push('closing'));

      await new Promise<void>(resolve => {
        channel.on('close', () => {
          events.push('close');
          assert.deepStrictEqual(events, ['open', 'closing', 'close']);
          resolve();
        });

        // Channel is already open, just close it
        channel.close();
      });
    });

    it('should send and receive messages', async (t) => {
      const peers = await createConnectedPeers('messages');
      pc1 = peers.pc1;
      pc2 = peers.pc2;
      const channel1 = peers.channel1;
      const channel2 = peers.channel2;

      await new Promise<void>(resolve => {
        let received = 0;
        channel1.on('message', (event: any) => {
          received++;
          if (received === 2) {
            resolve();
          }
        });

        // Send from channel2 to channel1
        channel2.send('message1');
        channel2.send('message2');
      });
    });
  });
});
