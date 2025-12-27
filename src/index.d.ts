// Type definitions for node-rtc-connection
// Project: https://github.com/nmhung1210/nodertc
// Definitions by: nmhung1210

/// <reference types="node" />

import { EventEmitter } from 'events';

// RTCConfiguration
export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
  credentialType?: 'password' | 'oauth';
}

export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
  bundlePolicy?: 'balanced' | 'max-compat' | 'max-bundle';
  rtcpMuxPolicy?: 'negotiate' | 'require';
  iceCandidatePoolSize?: number;
}

// RTCSessionDescription
export type RTCSdpType = 'offer' | 'answer' | 'pranswer' | 'rollback';

export interface RTCSessionDescriptionInit {
  type: RTCSdpType;
  sdp?: string;
}

export class RTCSessionDescription {
  constructor(descriptionInitDict?: RTCSessionDescriptionInit);
  readonly type: RTCSdpType;
  readonly sdp: string;
  toJSON(): RTCSessionDescriptionInit;
}

// RTCIceCandidate
export type RTCIceCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';
export type RTCIceProtocol = 'udp' | 'tcp';
export type RTCIceTcpCandidateType = 'active' | 'passive' | 'so';

export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export class RTCIceCandidate {
  constructor(candidateInitDict?: RTCIceCandidateInit);
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly foundation: string | null;
  readonly component: 'rtp' | 'rtcp' | null;
  readonly priority: number | null;
  readonly address: string | null;
  readonly protocol: RTCIceProtocol | null;
  readonly port: number | null;
  readonly type: RTCIceCandidateType | null;
  readonly tcpType: RTCIceTcpCandidateType | null;
  readonly relatedAddress: string | null;
  readonly relatedPort: number | null;
  readonly usernameFragment: string | null;
  toJSON(): RTCIceCandidateInit;
}

// RTCDataChannel
export type RTCDataChannelState = 'connecting' | 'open' | 'closing' | 'closed';
export type RTCBinaryType = 'blob' | 'arraybuffer';

export interface RTCDataChannelInit {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

export interface RTCDataChannelEventMap {
  open: Event;
  message: MessageEvent;
  error: RTCErrorEvent;
  close: Event;
  bufferedamountlow: Event;
}

export class RTCDataChannel extends EventEmitter {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  readonly id: number | null;
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: RTCBinaryType;

  close(): void;
  send(data: string | ArrayBuffer | ArrayBufferView): void;

  on<K extends keyof RTCDataChannelEventMap>(event: K, listener: (ev: RTCDataChannelEventMap[K]) => void): this;
  once<K extends keyof RTCDataChannelEventMap>(event: K, listener: (ev: RTCDataChannelEventMap[K]) => void): this;
  off<K extends keyof RTCDataChannelEventMap>(event: K, listener: (ev: RTCDataChannelEventMap[K]) => void): this;
  emit<K extends keyof RTCDataChannelEventMap>(event: K, ...args: any[]): boolean;
}

// RTCPeerConnection
export type RTCSignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer' | 
  'have-local-pranswer' | 'have-remote-pranswer' | 'closed';

export type RTCIceGatheringState = 'new' | 'gathering' | 'complete';

export type RTCIceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 
  'failed' | 'disconnected' | 'closed';

export type RTCPeerConnectionState = 'new' | 'connecting' | 'connected' | 
  'disconnected' | 'failed' | 'closed';

export interface RTCOfferOptions {
  iceRestart?: boolean;
  offerToReceiveAudio?: boolean;
  offerToReceiveVideo?: boolean;
}

export interface RTCAnswerOptions {
  iceRestart?: boolean;
}

export interface RTCDataChannelEventInit {
  channel: RTCDataChannel;
}

export class RTCDataChannelEvent extends Event {
  constructor(type: string, eventInitDict: RTCDataChannelEventInit);
  readonly channel: RTCDataChannel;
}

export interface RTCPeerConnectionIceEventInit {
  candidate?: RTCIceCandidate | null;
  url?: string | null;
}

export class RTCPeerConnectionIceEvent extends Event {
  constructor(type: string, eventInitDict?: RTCPeerConnectionIceEventInit);
  readonly candidate: RTCIceCandidate | null;
  readonly url: string | null;
}

export interface RTCPeerConnectionEventMap {
  connectionstatechange: Event;
  datachannel: RTCDataChannelEvent;
  icecandidate: RTCPeerConnectionIceEvent;
  icecandidateerror: Event;
  iceconnectionstatechange: Event;
  icegatheringstatechange: Event;
  negotiationneeded: Event;
  signalingstatechange: Event;
}

export class RTCPeerConnection extends EventEmitter {
  constructor(configuration?: RTCConfiguration, factory?: NativePeerConnectionFactory);

  readonly signalingState: RTCSignalingState;
  readonly iceGatheringState: RTCIceGatheringState;
  readonly iceConnectionState: RTCIceConnectionState;
  readonly connectionState: RTCPeerConnectionState;
  readonly localDescription: RTCSessionDescription | null;
  readonly remoteDescription: RTCSessionDescription | null;
  readonly pendingLocalDescription: RTCSessionDescription | null;
  readonly pendingRemoteDescription: RTCSessionDescription | null;
  readonly currentLocalDescription: RTCSessionDescription | null;
  readonly currentRemoteDescription: RTCSessionDescription | null;

  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescription>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescription>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  createDataChannel(label: string, dataChannelDict?: RTCDataChannelInit): RTCDataChannel;
  getConfiguration(): RTCConfiguration;
  setConfiguration(configuration: RTCConfiguration): void;
  close(): void;
  getStats(): Promise<any>;

  on<K extends keyof RTCPeerConnectionEventMap>(event: K, listener: (ev: RTCPeerConnectionEventMap[K]) => void): this;
  once<K extends keyof RTCPeerConnectionEventMap>(event: K, listener: (ev: RTCPeerConnectionEventMap[K]) => void): this;
  off<K extends keyof RTCPeerConnectionEventMap>(event: K, listener: (ev: RTCPeerConnectionEventMap[K]) => void): this;
  emit<K extends keyof RTCPeerConnectionEventMap>(event: K, ...args: any[]): boolean;
}

// RTCError
export class RTCError extends Error {
  constructor(message: string, errorDetail?: string);
  readonly errorDetail: string;
}

export interface RTCErrorEventInit {
  error: RTCError;
}

export class RTCErrorEvent extends Event {
  constructor(type: string, eventInitDict: RTCErrorEventInit);
  readonly error: RTCError;
}

// NativePeerConnectionFactory
export class NativePeerConnectionFactory {
  constructor();
  initialize(): void;
  createPeerConnection(configuration: RTCConfiguration): any;
  dispose(): void;
}

// Factory functions
export function createPeerConnection(configuration?: RTCConfiguration): RTCPeerConnection;
export function createPeerConnectionWithFactory(configuration: RTCConfiguration, factory: NativePeerConnectionFactory): RTCPeerConnection;

// Alias
export { RTCPeerConnection as RTCConnection };

// Default factory instance
export const defaultFactory: NativePeerConnectionFactory;
