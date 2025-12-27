/**
 * @fileoverview node-rtc-connection - WebRTC DataChannel implementation for Node.js
 * 
 * A clean-room implementation of WebRTC peer connections and data channels
 * for Node.js, ported from Chromium's production WebRTC code.
 * 
 * This implementation focuses on DataChannel functionality without media streams.
 * Features:
 * - ICE (Interactive Connectivity Establishment)
 * - STUN/TURN support for NAT traversal
 * - DTLS encryption
 * - SCTP for reliable data channels
 * - Full WebRTC API compatibility
 * 
 * @license BSD-3-Clause
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
