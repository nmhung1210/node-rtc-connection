/**
 * @file datachannel-manager.ts
 * @description Bridges SCTP streams + DCEP to RTCDataChannel instances.
 * @module sctp/datachannel-manager
 *
 * Responsibilities:
 *  - Allocate SCTP stream IDs per RFC 8832 §6: the DTLS client (a=setup:active)
 *    uses even stream IDs, the DTLS server uses odd.
 *  - Send DATA_CHANNEL_OPEN and await DATA_CHANNEL_ACK; respond to inbound OPEN.
 *  - Map outgoing string/binary sends to the correct PPID, and incoming PPIDs
 *    back to string/binary, including the EMPTY variants for zero-length data.
 */

'use strict';

import { EventEmitter } from 'events';
import * as dcep from './dcep';
import { PPID } from './chunks';
import type { SctpAssociation, SctpMessage } from './association';
import { RTCDataChannel } from '../datachannel/RTCDataChannel';

/** Subset of RTCDataChannelInit used when opening/accepting channels. */
interface ChannelInit {
  ordered?: boolean;
  maxRetransmits?: number | null;
  maxPacketLifeTime?: number | null;
  protocol?: string;
}

/** A locally tracked channel and whether its DCEP open has been acked. */
interface ChannelEntry {
  channel: RTCDataChannel;
  acked: boolean;
}

/** Information surfaced on the 'open-request' event for an inbound channel. */
export interface OpenRequestInfo {
  streamId: number;
  label: string;
  protocol: string;
  ordered: boolean;
  channelType: number;
  reliabilityParameter: number;
}

class DataChannelManager extends EventEmitter {
  #sctp: SctpAssociation;
  #channels: Map<number, ChannelEntry>; // streamId -> { channel, acked }
  #nextStreamId: number;

  /**
   * @param {import('./association').SctpAssociation} association
   * @param {boolean} isDtlsClient - true if we are the DTLS client (even IDs)
   */
  constructor(association: SctpAssociation, isDtlsClient: boolean) {
    super();
    this.#sctp = association;
    this.#channels = new Map(); // streamId -> { channel, acked }
    this.#nextStreamId = isDtlsClient ? 0 : 1;

    this.#sctp.on('message', (m: SctpMessage) => this.#onSctpMessage(m));
  }

  /**
   * Open a channel initiated locally.
   * @param {import('../datachannel/RTCDataChannel').RTCDataChannel} channel
   * @param {Object} init - { ordered, maxRetransmits, maxPacketLifeTime, protocol }
   */
  openChannel(channel: RTCDataChannel, init: ChannelInit = {}): void {
    const ctl = RTCDataChannel.control(channel);
    let streamId = channel.id;
    if (streamId === null || streamId === undefined) {
      streamId = this.#allocateStreamId();
      ctl.setId(streamId);
    }
    this.#channels.set(streamId, { channel, acked: false });
    this.#attachSender(channel, streamId, init);

    if (!channel.negotiated) {
      const open = dcep.encodeOpen({
        channelType: this.#channelType(init),
        priority: 0,
        reliabilityParameter: this.#reliabilityParam(init),
        label: channel.label,
        protocol: init.protocol || channel.protocol || '',
      });
      this.#sctp.sendData(streamId, PPID.DCEP, open);
      // Negotiated=false channels open after receiving DATA_CHANNEL_ACK.
    } else {
      // Pre-negotiated: considered open immediately.
      (this.#channels.get(streamId) as ChannelEntry).acked = true;
      ctl.open();
    }
  }

  #allocateStreamId(): number {
    let id = this.#nextStreamId;
    while (this.#channels.has(id)) id += 2;
    this.#nextStreamId = id + 2;
    return id;
  }

  #channelType(init: ChannelInit): number {
    const unordered = init.ordered === false;
    if (init.maxRetransmits != null) {
      return unordered
        ? dcep.CHANNEL_TYPE.PARTIAL_RELIABLE_REXMIT_UNORDERED
        : dcep.CHANNEL_TYPE.PARTIAL_RELIABLE_REXMIT;
    }
    if (init.maxPacketLifeTime != null) {
      return unordered
        ? dcep.CHANNEL_TYPE.PARTIAL_RELIABLE_TIMED_UNORDERED
        : dcep.CHANNEL_TYPE.PARTIAL_RELIABLE_TIMED;
    }
    return unordered ? dcep.CHANNEL_TYPE.RELIABLE_UNORDERED : dcep.CHANNEL_TYPE.RELIABLE;
  }

  #reliabilityParam(init: ChannelInit): number {
    if (init.maxRetransmits != null) return init.maxRetransmits >>> 0;
    if (init.maxPacketLifeTime != null) return init.maxPacketLifeTime >>> 0;
    return 0;
  }

  /** Wire channel.send() -> SCTP DATA with the right PPID and ordering. */
  #attachSender(channel: RTCDataChannel, streamId: number, init: ChannelInit): void {
    const unordered = init.ordered === false;
    RTCDataChannel.control(channel).setSender((data: Buffer, isBinary: boolean) => {
      let ppid: number;
      if (isBinary) {
        ppid = data.length === 0 ? PPID.BINARY_EMPTY : PPID.BINARY;
      } else {
        ppid = data.length === 0 ? PPID.STRING_EMPTY : PPID.STRING;
      }
      // EMPTY PPIDs still need one byte on the wire (RFC 8831 §6.6).
      const payload = data.length === 0 ? Buffer.from([0]) : data;
      this.#sctp.sendData(streamId, ppid, payload, { unordered });
    });
  }

  #onSctpMessage(m: SctpMessage): void {
    if (m.ppid === PPID.DCEP) {
      this.#onDcep(m);
      return;
    }
    const entry = this.#channels.get(m.streamId);
    if (!entry) return; // data for unknown channel
    const isBinary = m.ppid === PPID.BINARY || m.ppid === PPID.BINARY_EMPTY || m.ppid === PPID.BINARY_PARTIAL;
    const isEmpty = m.ppid === PPID.STRING_EMPTY || m.ppid === PPID.BINARY_EMPTY;
    const data = isEmpty ? Buffer.alloc(0) : m.data;
    RTCDataChannel.control(entry.channel).receiveMessage(data, isBinary);
  }

  #onDcep(m: SctpMessage): void {
    const type = dcep.messageType(m.data);
    if (type === dcep.MESSAGE_TYPE.DATA_CHANNEL_OPEN) {
      const open = dcep.decodeOpen(m.data);
      // Acknowledge and surface a new inbound channel.
      this.#sctp.sendData(m.streamId, PPID.DCEP, dcep.encodeAck());
      this.emit('open-request', {
        streamId: m.streamId,
        label: open.label,
        protocol: open.protocol,
        ordered: !open.unordered,
        channelType: open.channelType,
        reliabilityParameter: open.reliabilityParameter,
      });
    } else if (type === dcep.MESSAGE_TYPE.DATA_CHANNEL_ACK) {
      const entry = this.#channels.get(m.streamId);
      if (entry && !entry.acked) {
        entry.acked = true;
        RTCDataChannel.control(entry.channel).open();
      }
    }
  }

  /**
   * Register an inbound channel (created in response to 'open-request') and
   * attach its sender.
   */
  acceptChannel(channel: RTCDataChannel, info: OpenRequestInfo): void {
    const ctl = RTCDataChannel.control(channel);
    ctl.setId(info.streamId);
    this.#channels.set(info.streamId, { channel, acked: true });
    this.#attachSender(channel, info.streamId, { ordered: info.ordered });
    ctl.open();
  }
}

export { DataChannelManager };
