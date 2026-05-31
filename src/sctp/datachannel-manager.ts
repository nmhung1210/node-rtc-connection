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
import type { RTCDataChannel } from '../datachannel/RTCDataChannel';

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
  private _sctp: SctpAssociation;
  _isDtlsClient: boolean;
  private _channels: Map<number, ChannelEntry>; // streamId -> { channel, acked }
  private _nextStreamId: number;

  /**
   * @param {import('./association').SctpAssociation} association
   * @param {boolean} isDtlsClient - true if we are the DTLS client (even IDs)
   */
  constructor(association: SctpAssociation, isDtlsClient: boolean) {
    super();
    this._sctp = association;
    this._isDtlsClient = isDtlsClient;
    this._channels = new Map(); // streamId -> { channel, acked }
    this._nextStreamId = isDtlsClient ? 0 : 1;

    this._sctp.on('message', (m: SctpMessage) => this._onSctpMessage(m));
  }

  /**
   * Open a channel initiated locally.
   * @param {import('../datachannel/RTCDataChannel').RTCDataChannel} channel
   * @param {Object} init - { ordered, maxRetransmits, maxPacketLifeTime, protocol }
   */
  openChannel(channel: RTCDataChannel, init: ChannelInit = {}): void {
    let streamId = channel.id;
    if (streamId === null || streamId === undefined) {
      streamId = this._allocateStreamId();
      channel._setId(streamId);
    }
    this._channels.set(streamId, { channel, acked: false });
    this._attachSender(channel, streamId, init);

    if (!channel.negotiated) {
      const open = dcep.encodeOpen({
        channelType: this._channelType(init),
        priority: 0,
        reliabilityParameter: this._reliabilityParam(init),
        label: channel.label,
        protocol: init.protocol || channel.protocol || '',
      });
      this._sctp.sendData(streamId, PPID.DCEP, open);
      // Negotiated=false channels open after receiving DATA_CHANNEL_ACK.
    } else {
      // Pre-negotiated: considered open immediately.
      (this._channels.get(streamId) as ChannelEntry).acked = true;
      channel._setStateToOpen();
    }
  }

  private _allocateStreamId(): number {
    let id = this._nextStreamId;
    while (this._channels.has(id)) id += 2;
    this._nextStreamId = id + 2;
    return id;
  }

  private _channelType(init: ChannelInit): number {
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

  private _reliabilityParam(init: ChannelInit): number {
    if (init.maxRetransmits != null) return init.maxRetransmits >>> 0;
    if (init.maxPacketLifeTime != null) return init.maxPacketLifeTime >>> 0;
    return 0;
  }

  /** Wire channel.send() -> SCTP DATA with the right PPID and ordering. */
  private _attachSender(channel: RTCDataChannel, streamId: number, init: ChannelInit): void {
    const unordered = init.ordered === false;
    channel._setSender((data: Buffer, isBinary: boolean) => {
      let ppid: number;
      if (isBinary) {
        ppid = data.length === 0 ? PPID.BINARY_EMPTY : PPID.BINARY;
      } else {
        ppid = data.length === 0 ? PPID.STRING_EMPTY : PPID.STRING;
      }
      // EMPTY PPIDs still need one byte on the wire (RFC 8831 §6.6).
      const payload = data.length === 0 ? Buffer.from([0]) : data;
      this._sctp.sendData(streamId, ppid, payload, { unordered });
    });
  }

  private _onSctpMessage(m: SctpMessage): void {
    if (m.ppid === PPID.DCEP) {
      this._onDcep(m);
      return;
    }
    const entry = this._channels.get(m.streamId);
    if (!entry) return; // data for unknown channel
    const isBinary = m.ppid === PPID.BINARY || m.ppid === PPID.BINARY_EMPTY || m.ppid === PPID.BINARY_PARTIAL;
    const isEmpty = m.ppid === PPID.STRING_EMPTY || m.ppid === PPID.BINARY_EMPTY;
    const data = isEmpty ? Buffer.alloc(0) : m.data;
    entry.channel._receiveMessage(data, isBinary);
  }

  private _onDcep(m: SctpMessage): void {
    const type = dcep.messageType(m.data);
    if (type === dcep.MESSAGE_TYPE.DATA_CHANNEL_OPEN) {
      const open = dcep.decodeOpen(m.data);
      // Acknowledge and surface a new inbound channel.
      this._sctp.sendData(m.streamId, PPID.DCEP, dcep.encodeAck());
      this.emit('open-request', {
        streamId: m.streamId,
        label: open.label,
        protocol: open.protocol,
        ordered: !open.unordered,
        channelType: open.channelType,
        reliabilityParameter: open.reliabilityParameter,
      });
    } else if (type === dcep.MESSAGE_TYPE.DATA_CHANNEL_ACK) {
      const entry = this._channels.get(m.streamId);
      if (entry && !entry.acked) {
        entry.acked = true;
        entry.channel._setStateToOpen();
      }
    }
  }

  /**
   * Register an inbound channel (created in response to 'open-request') and
   * attach its sender.
   */
  acceptChannel(channel: RTCDataChannel, info: OpenRequestInfo): void {
    channel._setId(info.streamId);
    this._channels.set(info.streamId, { channel, acked: true });
    this._attachSender(channel, info.streamId, { ordered: info.ordered });
    channel._setStateToOpen();
  }
}

export { DataChannelManager };
