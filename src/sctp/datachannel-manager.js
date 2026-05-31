/**
 * @file datachannel-manager.js
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

const EventEmitter = require('events');
const dcep = require('./dcep');
const { PPID } = require('./chunks');

class DataChannelManager extends EventEmitter {
  /**
   * @param {import('./association').SctpAssociation} association
   * @param {boolean} isDtlsClient - true if we are the DTLS client (even IDs)
   */
  constructor(association, isDtlsClient) {
    super();
    this._sctp = association;
    this._isDtlsClient = isDtlsClient;
    this._channels = new Map(); // streamId -> { channel, acked }
    this._nextStreamId = isDtlsClient ? 0 : 1;

    this._sctp.on('message', (m) => this._onSctpMessage(m));
  }

  /**
   * Open a channel initiated locally.
   * @param {import('../datachannel/RTCDataChannel').RTCDataChannel} channel
   * @param {Object} init - { ordered, maxRetransmits, maxPacketLifeTime, protocol }
   */
  openChannel(channel, init = {}) {
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
      this._channels.get(streamId).acked = true;
      channel._setStateToOpen();
    }
  }

  _allocateStreamId() {
    let id = this._nextStreamId;
    while (this._channels.has(id)) id += 2;
    this._nextStreamId = id + 2;
    return id;
  }

  _channelType(init) {
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

  _reliabilityParam(init) {
    if (init.maxRetransmits != null) return init.maxRetransmits >>> 0;
    if (init.maxPacketLifeTime != null) return init.maxPacketLifeTime >>> 0;
    return 0;
  }

  /** Wire channel.send() -> SCTP DATA with the right PPID and ordering. */
  _attachSender(channel, streamId, init) {
    const unordered = init.ordered === false;
    channel._setSender((data, isBinary) => {
      let ppid;
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

  _onSctpMessage(m) {
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

  _onDcep(m) {
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
  acceptChannel(channel, info) {
    channel._setId(info.streamId);
    this._channels.set(info.streamId, { channel, acked: true });
    this._attachSender(channel, info.streamId, { ordered: info.ordered });
    channel._setStateToOpen();
  }
}

module.exports = { DataChannelManager };
