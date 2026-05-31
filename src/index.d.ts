// Type definitions for node-rtc-connection
// Project: https://github.com/nmhung1210/nodertc
// Definitions by: nmhung1210

/// <reference types="node" />

/**
 * ByteBufferQueue - Efficient byte buffer with O(1) append and O(n) read
 */
export class ByteBufferQueue {
  constructor();
  readonly size: number;
  readonly empty: boolean;
  readInto(buffer: Buffer): number;
  append(buffer: Buffer): void;
  clear(): void;
  read(n: number): Buffer;
  peek(n?: number): Buffer;
}

/**
 * RTCError - WebRTC-specific error types
 */
export interface RTCErrorInit {
  errorDetail?: string;
  sdpLineNumber?: number;
  httpRequestStatusCode?: number;
  sctpCauseCode?: number;
  receivedAlert?: number;
  sentAlert?: number;
}

export interface RTCErrorDetailType {
  NONE: string;
  DATA_CHANNEL_FAILURE: string;
  DTLS_FAILURE: string;
  FINGERPRINT_FAILURE: string;
  SCTP_FAILURE: string;
  SDP_SYNTAX_ERROR: string;
  HARDWARE_ENCODER_NOT_AVAILABLE: string;
  HARDWARE_ENCODER_ERROR: string;
  INVALID_STATE: string;
  INVALID_MODIFICATION: string;
  INVALID_ACCESS_ERROR: string;
  OPERATION_ERROR: string;
}

export class RTCError extends Error {
  constructor(init?: RTCErrorInit, message?: string);
  readonly errorDetail: string;
  readonly sdpLineNumber: number | null;
  readonly httpRequestStatusCode: number | null;
  readonly sctpCauseCode: number | null;
  readonly receivedAlert: number | null;
  readonly sentAlert: number | null;
  toJSON(): object;
  static fromNative(nativeError: any): RTCError;
  static DetailType: RTCErrorDetailType;
}

/**
 * RTCIceCandidate - ICE candidate representation
 */
export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string;
}

export class RTCIceCandidate {
  constructor(candidateInit?: RTCIceCandidateInit);
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;
  readonly usernameFragment: string | null;
  readonly foundation: string | null;
  readonly component: string | null;
  readonly priority: number | null;
  readonly address: string | null;
  readonly protocol: string | null;
  readonly port: number | null;
  readonly type: string | null;
  readonly tcpType: string | null;
  readonly relatedAddress: string | null;
  readonly relatedPort: number | null;
  toJSON(): object;
  static fromString(candidateStr: string, sdpMid?: string | null, sdpMLineIndex?: number | null): RTCIceCandidate;
  static isValid(candidateStr: string): boolean;
}

import { EventEmitter } from 'events';

/**
 * RTCCertificate - DTLS certificate
 */
export interface RTCDtlsFingerprint {
  algorithm: string;
  value: string;
}

export interface RTCCertificatePEM {
  pemPrivateKey: string;
  pemCertificate: string;
}

export interface RTCCertificateOptions {
  name?: string;
  expires?: number;
  days?: number;
  hash?: string;
}

export interface RTCKeyParams {
  type: 'RSA' | 'ECDSA';
  rsaModulusLength?: number;
  namedCurve?: string;
}

export class RTCCertificate {
  readonly expires: number;
  getFingerprints(): RTCDtlsFingerprint[];
  getPrivateKey(): string;
  getPublicKey(): string;
  toPEM(): RTCCertificatePEM;
  isExpired(): boolean;
  
  static generateCertificate(options?: RTCCertificateOptions): Promise<RTCCertificate>;
  static fromPEM(pemPrivateKey: string, pemCertificate: string, expires?: number): RTCCertificate;
  static isSupportedKeyParams(keyParams: RTCKeyParams): boolean;
}

/**
 * RTCDataChannel - Bidirectional data channel
 */
export enum RTCDataChannelState {
  CONNECTING = 'connecting',
  OPEN = 'open',
  CLOSING = 'closing',
  CLOSED = 'closed'
}

export interface RTCDataChannelInit {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
}

export interface RTCDataChannelMessageEvent {
  data: string | Buffer | ArrayBuffer;
}

export class RTCDataChannel extends EventEmitter {
  constructor(label: string, init?: RTCDataChannelInit);
  readonly label: string;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly protocol: string;
  readonly negotiated: boolean;
  readonly id: number | null;
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: 'arraybuffer' | 'blob';
  readonly reliable: boolean;
  
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(): void;
  
  on(event: 'open', listener: () => void): this;
  on(event: 'message', listener: (event: RTCDataChannelMessageEvent) => void): this;
  on(event: 'bufferedamountlow', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'closing', listener: () => void): this;
  on(event: 'close', listener: () => void): this;
}

/**
 * RTCSessionDescription - SDP representation
 */
export enum RTCSdpType {
  OFFER = 'offer',
  PRANSWER = 'pranswer',
  ANSWER = 'answer',
  ROLLBACK = 'rollback'
}

export interface RTCSessionDescriptionInit {
  type?: string;
  sdp?: string;
}

export class RTCSessionDescription {
  constructor(init?: RTCSessionDescriptionInit);
  type: string | null;
  sdp: string | null;
  toJSON(): RTCSessionDescriptionInit;
}

/**
 * RTCPeerConnection - Main peer connection class
 */
export enum RTCSignalingState {
  STABLE = 'stable',
  HAVE_LOCAL_OFFER = 'have-local-offer',
  HAVE_REMOTE_OFFER = 'have-remote-offer',
  HAVE_LOCAL_PRANSWER = 'have-local-pranswer',
  HAVE_REMOTE_PRANSWER = 'have-remote-pranswer',
  CLOSED = 'closed'
}

export enum RTCIceGatheringState {
  NEW = 'new',
  GATHERING = 'gathering',
  COMPLETE = 'complete'
}

export enum RTCPeerConnectionState {
  NEW = 'new',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  FAILED = 'failed',
  CLOSED = 'closed'
}

export interface RTCIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface RTCConfiguration {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: 'all' | 'relay';
  bundlePolicy?: 'balanced' | 'max-compat' | 'max-bundle';
}

export interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export class RTCPeerConnection extends EventEmitter {
  constructor(configuration?: RTCConfiguration);
  
  readonly signalingState: string;
  readonly iceGatheringState: string;
  readonly iceConnectionState: string;
  readonly connectionState: string;
  readonly localDescription: RTCSessionDescription | null;
  readonly remoteDescription: RTCSessionDescription | null;
  readonly currentLocalDescription: RTCSessionDescription | null;
  readonly pendingLocalDescription: RTCSessionDescription | null;
  readonly currentRemoteDescription: RTCSessionDescription | null;
  readonly pendingRemoteDescription: RTCSessionDescription | null;
  readonly canTrickleIceCandidates: boolean;
  /** The underlying SCTP association once established (internal shape), or null. */
  readonly sctp: any | null;
  
  createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel;
  createOffer(options?: any): Promise<RTCSessionDescription>;
  createAnswer(options?: any): Promise<RTCSessionDescription>;
  setLocalDescription(description?: RTCSessionDescription): Promise<void>;
  setRemoteDescription(description: RTCSessionDescription): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void>;
  getConfiguration(): RTCConfiguration;
  setConfiguration(configuration: RTCConfiguration): void;
  close(): void;
  
  on(event: 'negotiationneeded', listener: () => void): this;
  on(event: 'icecandidate', listener: (event: { candidate: RTCIceCandidateInit | null }) => void): this;
  on(event: 'icegatheringstatechange', listener: () => void): this;
  on(event: 'iceconnectionstatechange', listener: () => void): this;
  on(event: 'connectionstatechange', listener: () => void): this;
  on(event: 'signalingstatechange', listener: () => void): this;
  on(event: 'datachannel', listener: (event: { channel: RTCDataChannel }) => void): this;
}

/**
 * Package version
 */
export const version: string;

