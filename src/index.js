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

// Foundation Layer
const ByteBufferQueue = require('./foundation/ByteBufferQueue');
const RTCError = require('./foundation/RTCError');

// ICE Layer
const RTCIceCandidate = require('./ice/RTCIceCandidate');
const { 
  RTCIceTransport, 
  RTCIceRole, 
  RTCIceTransportState, 
  RTCIceGatheringState 
} = require('./ice/RTCIceTransport');

// DTLS Layer
const RTCCertificate = require('./dtls/RTCCertificate');
const { RTCDtlsTransport, RTCDtlsTransportState } = require('./dtls/RTCDtlsTransport');

// SCTP Layer
const { RTCSctpTransport, RTCSctpTransportState } = require('./sctp/RTCSctpTransport');

// DataChannel Layer
const { RTCDataChannel, RTCDataChannelState } = require('./datachannel/RTCDataChannel');

// SDP Layer
const { RTCSessionDescription, RTCSdpType } = require('./sdp/RTCSessionDescription');

// PeerConnection Layer
const { 
  RTCPeerConnection, 
  RTCSignalingState, 
  RTCIceGatheringState: RTCIceGatheringStatePC,
  RTCPeerConnectionState 
} = require('./peerconnection/RTCPeerConnection');

// Export all public APIs
module.exports = {
  // Foundation
  ByteBufferQueue,
  RTCError,
  
  // ICE
  RTCIceCandidate,
  RTCIceTransport,
  RTCIceRole,
  RTCIceTransportState,
  RTCIceGatheringState,
  
  // DTLS
  RTCCertificate,
  RTCDtlsTransport,
  RTCDtlsTransportState,
  
  // SCTP
  RTCSctpTransport,
  RTCSctpTransportState,
  
  // DataChannel
  RTCDataChannel,
  RTCDataChannelState,
  
  // SDP
  RTCSessionDescription,
  RTCSdpType,
  
  // PeerConnection
  RTCPeerConnection,
  RTCSignalingState,
  RTCPeerConnectionState,
  
  // Version
  version: require('../package.json').version
};
