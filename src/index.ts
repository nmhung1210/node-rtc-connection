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

// Foundation
import ByteBufferQueue from './foundation/ByteBufferQueue';
import RTCError from './foundation/RTCError';

// ICE / certificates
import RTCIceCandidate from './ice/RTCIceCandidate';
import RTCCertificate from './dtls/RTCCertificate';

// DataChannel
import { RTCDataChannel, RTCDataChannelState } from './datachannel/RTCDataChannel';

// SDP
import { RTCSessionDescription, RTCSdpType } from './sdp/RTCSessionDescription';

// PeerConnection
import {
  RTCPeerConnection,
  RTCSignalingState,
  RTCIceGatheringState,
  RTCPeerConnectionState,
} from './peerconnection/RTCPeerConnection';

import pkg from '../package.json';

export {
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
};

export const version: string = pkg.version;

// Re-export public types for consumers.
export type { RTCDataChannelInit } from './datachannel/RTCDataChannel';
export type { RTCSessionDescriptionInit } from './sdp/RTCSessionDescription';
export type { TransportStackOptions } from './transport-stack';
