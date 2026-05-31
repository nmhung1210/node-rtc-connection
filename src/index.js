/**
 * @fileoverview node-rtc-connection - WebRTC DataChannel implementation for Node.js
 *
 * A from-scratch, pure-Node.js implementation of WebRTC peer connections and
 * data channels (no native dependencies). Interoperates with browsers.
 *
 * This implementation focuses on DataChannel functionality without media streams.
 * Features:
 * - ICE (Interactive Connectivity Establishment), RFC 8445
 * - STUN/TURN support for NAT traversal
 * - DTLS 1.2 encryption (RFC 6347)
 * - SCTP over DTLS + DCEP for data channels (RFC 8831 / 8832)
 * - W3C-compatible RTCPeerConnection / RTCDataChannel API
 *
 * @license MIT
 * @author nmhung1210
 */

'use strict';

// Foundation
const ByteBufferQueue = require('./foundation/ByteBufferQueue');
const RTCError = require('./foundation/RTCError');

// ICE / certificates
const RTCIceCandidate = require('./ice/RTCIceCandidate');
const RTCCertificate = require('./dtls/RTCCertificate');

// DataChannel
const { RTCDataChannel, RTCDataChannelState } = require('./datachannel/RTCDataChannel');

// SDP
const { RTCSessionDescription, RTCSdpType } = require('./sdp/RTCSessionDescription');

// PeerConnection
const {
  RTCPeerConnection,
  RTCSignalingState,
  RTCIceGatheringState,
  RTCPeerConnectionState,
} = require('./peerconnection/RTCPeerConnection');

module.exports = {
  // Foundation
  ByteBufferQueue,
  RTCError,

  // ICE / certificates
  RTCIceCandidate,
  RTCCertificate,

  // DataChannel
  RTCDataChannel,
  RTCDataChannelState,

  // SDP
  RTCSessionDescription,
  RTCSdpType,

  // PeerConnection
  RTCPeerConnection,
  RTCSignalingState,
  RTCIceGatheringState,
  RTCPeerConnectionState,

  // Version
  version: require('../package.json').version,
};
