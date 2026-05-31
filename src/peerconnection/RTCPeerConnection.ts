/**
 * @file RTCPeerConnection.ts
 * @description WebRTC peer connection driving a real ICE/DTLS/SCTP/DCEP stack.
 * @module peerconnection/RTCPeerConnection
 *
 * This orchestrates signaling (offer/answer + ICE candidate trickle) on top of
 * src/transport-stack.ts, which implements the actual on-the-wire protocols.
 * It interoperates with browser RTCPeerConnection for data channels.
 */

'use strict';

import { EventEmitter } from 'events';
import RTCCertificate from '../dtls/RTCCertificate';
import { RTCSessionDescription, RTCSdpType, RTCSessionDescriptionInit } from '../sdp/RTCSessionDescription';
import { RTCDataChannel, RTCDataChannelInit } from '../datachannel/RTCDataChannel';
import * as sdpUtils from '../sdp/sdp-utils';
import { IceCredentials, Fingerprint } from '../sdp/sdp-utils';
import { TransportStack } from '../transport-stack';
import type { OpenRequestInfo } from '../sctp/datachannel-manager';

/** Configuration accepted by {@link RTCPeerConnection}. */
export interface RTCConfiguration {
  iceServers?: unknown[];
  iceTransportPolicy?: 'all' | 'relay';
  certificates?: RTCCertificate[];
}

/** A queued local channel awaiting an established SCTP association. */
interface PendingChannel {
  channel: RTCDataChannel;
  init: RTCDataChannelInit;
}

/** Candidate descriptor emitted by the ICE agent through the stack. */
interface StackCandidate {
  sdp: string;
}

export const RTCSignalingState = Object.freeze({
  STABLE: 'stable',
  HAVE_LOCAL_OFFER: 'have-local-offer',
  HAVE_REMOTE_OFFER: 'have-remote-offer',
  HAVE_LOCAL_PRANSWER: 'have-local-pranswer',
  HAVE_REMOTE_PRANSWER: 'have-remote-pranswer',
  CLOSED: 'closed',
});

export const RTCIceGatheringState = Object.freeze({ NEW: 'new', GATHERING: 'gathering', COMPLETE: 'complete' });

export const RTCPeerConnectionState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

export class RTCPeerConnection extends EventEmitter {
  private _configuration: RTCConfiguration;
  private _signalingState: string;
  private _iceGatheringState: string;
  private _connectionState: string;

  private _localDescription: RTCSessionDescription | null;
  private _remoteDescription: RTCSessionDescription | null;

  private _certificate: RTCCertificate | null;
  private _localIce: IceCredentials;
  private _remoteIce: sdpUtils.IceParameters | null;
  private _remoteFingerprints: Fingerprint[];
  private _remoteSetup: string | null;

  private _stack: TransportStack | null;
  private _isOfferer: boolean;
  private _isClosed: boolean;

  private _pendingChannels: PendingChannel[];
  private _channels: Set<RTCDataChannel>;
  private _localCandidates: RTCIceCandidateInit[];

  constructor(configuration: RTCConfiguration = {}) {
    super();
    this._configuration = configuration;
    this._signalingState = RTCSignalingState.STABLE;
    this._iceGatheringState = RTCIceGatheringState.NEW;
    this._connectionState = RTCPeerConnectionState.NEW;

    this._localDescription = null;
    this._remoteDescription = null;

    this._certificate = null;
    this._localIce = sdpUtils.generateIceCredentials();
    this._remoteIce = null;
    this._remoteFingerprints = [];
    this._remoteSetup = null;

    this._stack = null;
    this._isOfferer = false;
    this._isClosed = false;

    // Data channels created locally before the stack is ready are queued and
    // opened once SCTP is established.
    this._pendingChannels = [];
    this._channels = new Set();
    this._localCandidates = [];
  }

  // ---- lazy init ----------------------------------------------------------

  async _ensureCertificate(): Promise<RTCCertificate> {
    if (!this._certificate) {
      if (this._configuration.certificates && this._configuration.certificates[0]) {
        this._certificate = this._configuration.certificates[0];
      } else {
        this._certificate = await RTCCertificate.generateCertificate();
      }
    }
    return this._certificate;
  }

  /**
   * Create the transport stack once roles are known.
   * @param {'controlling'|'controlled'} iceRole
   * @param {'client'|'server'} dtlsRole
   */
  _createStack(iceRole: 'controlling' | 'controlled', dtlsRole: 'client' | 'server'): TransportStack {
    if (this._stack) return this._stack;

    const certificate = this._certificate;
    if (!certificate) {
      throw new Error('Certificate not initialized');
    }
    const certDer = certificate.getCertificateDer();
    if (!certDer) {
      throw new Error('Certificate has no DER encoding');
    }

    const stack = new TransportStack({
      iceRole,
      dtlsRole,
      localUfrag: this._localIce.usernameFragment,
      localPwd: this._localIce.password,
      certDer,
      privateKey: certificate.getPrivateKeyObject(),
      verifyFingerprint: (fp: { algorithm: string; value: string }) => this._verifyRemoteFingerprint(fp),
    });

    stack.on('candidate', (c: StackCandidate) => {
      const init: RTCIceCandidateInit = { candidate: c.sdp, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: this._localIce.usernameFragment };
      this._localCandidates.push(init);
      this.emit('icecandidate', { candidate: init });
    });

    stack.on('iceconnected', () => this._setConnectionState(RTCPeerConnectionState.CONNECTING));
    stack.on('sctpconnected', () => this._setConnectionState(RTCPeerConnectionState.CONNECTED));
    stack.on('error', (e: unknown) => {
      this.emit('error', e);
      this._setConnectionState(RTCPeerConnectionState.FAILED);
    });
    stack.on('close', () => this._setConnectionState(RTCPeerConnectionState.DISCONNECTED));

    // Inbound (remotely-initiated) data channels.
    stack.on('datachannel-request', (info: OpenRequestInfo) => {
      const channel = new RTCDataChannel(info.label, {
        ordered: info.ordered,
        protocol: info.protocol,
        id: info.streamId,
      });
      stack.acceptChannel(channel, info);
      this._channels.add(channel);
      this.emit('datachannel', { channel });
    });

    // Open any queued local channels when SCTP is ready.
    stack.on('ready', () => {
      for (const { channel, init } of this._pendingChannels) {
        stack.openChannel(channel, init);
      }
      this._pendingChannels = [];
    });

    this._stack = stack;
    return stack;
  }

  _verifyRemoteFingerprint(fp: { algorithm: string; value: string }): boolean {
    if (this._remoteFingerprints.length === 0) return true; // not yet known
    return this._remoteFingerprints.some(
      (rf) => rf.algorithm === fp.algorithm && rf.value.toUpperCase() === fp.value.toUpperCase()
    );
  }

  // ---- data channels ------------------------------------------------------

  createDataChannel(label: string, options: RTCDataChannelInit = {}): RTCDataChannel {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    const channel = new RTCDataChannel(label, options);
    this._channels.add(channel);

    const init: RTCDataChannelInit = {
      ordered: options.ordered !== false,
      maxRetransmits: options.maxRetransmits,
      maxPacketLifeTime: options.maxPacketLifeTime,
      protocol: options.protocol || '',
      negotiated: options.negotiated || false,
    };

    if (this._stack && this._stack.isReady()) {
      this._stack.openChannel(channel, init);
    } else {
      this._pendingChannels.push({ channel, init });
    }

    setImmediate(() => { if (!this._isClosed) this.emit('negotiationneeded'); });
    return channel;
  }

  // ---- signaling ----------------------------------------------------------

  async createOffer(): Promise<RTCSessionDescription> {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    await this._ensureCertificate();
    this._isOfferer = true;

    const fp = this._pickFingerprint();
    const sdp = sdpUtils.generateOffer({
      iceUfrag: this._localIce.usernameFragment,
      icePwd: this._localIce.password,
      fingerprint: fp,
      setup: 'actpass',
      candidates: [],
    });
    return new RTCSessionDescription({ type: RTCSdpType.OFFER, sdp });
  }

  async createAnswer(): Promise<RTCSessionDescription> {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    if (!this._remoteDescription || this._remoteDescription.type !== 'offer') {
      throw new Error('Cannot create answer without remote offer');
    }
    await this._ensureCertificate();

    // Answerer takes the active (DTLS client) role when offer is actpass.
    const fp = this._pickFingerprint();
    const sdp = sdpUtils.generateAnswer({
      iceUfrag: this._localIce.usernameFragment,
      icePwd: this._localIce.password,
      fingerprint: fp,
      setup: 'active',
      candidates: [],
    });
    return new RTCSessionDescription({ type: RTCSdpType.ANSWER, sdp });
  }

  _pickFingerprint(): Fingerprint | undefined {
    const certificate = this._certificate;
    if (!certificate) {
      throw new Error('Certificate not initialized');
    }
    const fps = certificate.getFingerprints();
    return fps.find((f) => f.algorithm === 'sha-256') || fps[0];
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit | RTCSessionDescription): Promise<void> {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    const desc: RTCSessionDescriptionInit | RTCSessionDescription = description
      ? description
      : this._signalingState === RTCSignalingState.HAVE_REMOTE_OFFER
        ? await this.createAnswer()
        : await this.createOffer();
    await this._ensureCertificate();
    this._localDescription = new RTCSessionDescription({ type: desc.type ?? undefined, sdp: desc.sdp ?? undefined });

    if (desc.type === 'offer') {
      this._signalingState = RTCSignalingState.HAVE_LOCAL_OFFER;
    } else if (desc.type === 'answer') {
      this._signalingState = RTCSignalingState.STABLE;
    }

    // Determine roles and bring up the stack so we start gathering immediately.
    this._setupRolesAndStack(desc, /*local*/ true);

    this._iceGatheringState = RTCIceGatheringState.GATHERING;
    this.emit('icegatheringstatechange');
    if (this._stack) {
      await this._stack.gather({
        iceServers: this._configuration.iceServers || [],
        iceTransportPolicy: this._configuration.iceTransportPolicy || 'all',
      });
      this._iceGatheringState = RTCIceGatheringState.COMPLETE;
      this.emit('icegatheringstatechange');
      // Signal end-of-candidates.
      this.emit('icecandidate', { candidate: null });
      this._maybeStartChecks();
    }
    this.emit('signalingstatechange');
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    if (!description || !description.sdp) throw new Error('Invalid session description');
    await this._ensureCertificate();

    this._remoteDescription = new RTCSessionDescription(description);
    if (description.type === 'offer') {
      this._signalingState = RTCSignalingState.HAVE_REMOTE_OFFER;
    } else if (description.type === 'answer') {
      this._signalingState = RTCSignalingState.STABLE;
    }

    this._remoteIce = sdpUtils.parseIceParameters(description.sdp);
    const dtls = sdpUtils.parseDtlsParameters(description.sdp);
    this._remoteFingerprints = dtls.fingerprints;
    this._remoteSetup = dtls.setup ?? null;

    this._setupRolesAndStack(description, /*local*/ false);

    // Apply remote credentials + any in-SDP candidates, then start checks.
    if (this._stack && this._remoteIce.usernameFragment) {
      this._stack.setRemote(this._remoteIce.usernameFragment, this._remoteIce.password ?? '');
      for (const c of sdpUtils.parseCandidates(description.sdp)) {
        this._stack.addRemoteCandidate(c);
      }
    }
    this._maybeStartChecks();
    this.emit('signalingstatechange');
  }

  /**
   * Decide ICE controlling/controlled and DTLS client/server, then create the
   * stack. Offerer is ICE-controlling. DTLS roles follow a=setup: the side that
   * ends up 'active' is the DTLS client.
   */
  _setupRolesAndStack(_description: RTCSessionDescriptionInit | RTCSessionDescription, _isLocal: boolean): void {
    if (this._stack) return;

    const iceRole: 'controlling' | 'controlled' = this._isOfferer ? 'controlling' : 'controlled';

    // Determine our DTLS role.
    let dtlsRole: 'client' | 'server';
    if (this._isOfferer) {
      // We offered actpass; the answerer chooses. We learn it from their answer
      // (setup:active => they are client => we are server). Until we see the
      // answer we default to server (passive), which matches answerer=active.
      if (this._remoteSetup === 'active') dtlsRole = 'server';
      else if (this._remoteSetup === 'passive') dtlsRole = 'client';
      else dtlsRole = 'server';
    } else {
      // We are the answerer; we chose 'active' in createAnswer => DTLS client.
      dtlsRole = 'client';
    }

    this._createStack(iceRole, dtlsRole);
  }

  _maybeStartChecks(): void {
    // Once both local gathering started and remote creds exist, checks run.
    if (this._stack && this._remoteIce && this._remoteIce.usernameFragment) {
      this._stack.setRemote(this._remoteIce.usernameFragment, this._remoteIce.password ?? '');
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | string): Promise<void> {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    if (!candidate || (typeof candidate !== 'string' && candidate.candidate === '')) {
      return; // end-of-candidates
    }
    const candidateStr = typeof candidate === 'string' ? candidate : (candidate.candidate || '');
    const parsed = sdpUtils.parseCandidateLine(candidateStr);
    if (parsed && this._stack) {
      this._stack.addRemoteCandidate(parsed);
    }
  }

  // ---- state --------------------------------------------------------------

  _setConnectionState(state: string): void {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this.emit('connectionstatechange');
      this.emit('iceconnectionstatechange');
    }
  }

  getConfiguration(): RTCConfiguration { return { ...this._configuration }; }
  setConfiguration(configuration: RTCConfiguration): void {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    this._configuration = { ...configuration };
  }

  close(): void {
    if (this._isClosed) return;
    this._isClosed = true;
    this._signalingState = RTCSignalingState.CLOSED;
    for (const channel of this._channels) {
      try { channel.close(); } catch (_) { /* best-effort */ }
    }
    if (this._stack) try { this._stack.close(); } catch (_) { /* best-effort */ }
    this._setConnectionState(RTCPeerConnectionState.CLOSED);
    this.emit('signalingstatechange');
  }

  get signalingState(): string { return this._signalingState; }
  get iceGatheringState(): string { return this._iceGatheringState; }
  get iceConnectionState(): string {
    return this._connectionState === RTCPeerConnectionState.CONNECTED ? 'connected'
      : this._connectionState === RTCPeerConnectionState.CONNECTING ? 'checking'
      : this._connectionState === RTCPeerConnectionState.FAILED ? 'failed'
      : 'new';
  }
  get connectionState(): string { return this._connectionState; }
  get localDescription(): RTCSessionDescription | null { return this._localDescription; }
  get remoteDescription(): RTCSessionDescription | null { return this._remoteDescription; }
  get currentLocalDescription(): RTCSessionDescription | null { return this._localDescription; }
  get currentRemoteDescription(): RTCSessionDescription | null { return this._remoteDescription; }
  get pendingLocalDescription(): RTCSessionDescription | null { return this._signalingState === RTCSignalingState.STABLE ? null : this._localDescription; }
  get pendingRemoteDescription(): RTCSessionDescription | null { return this._signalingState === RTCSignalingState.STABLE ? null : this._remoteDescription; }
  get canTrickleIceCandidates(): boolean { return true; }
  get sctp(): TransportStack['sctp'] { return this._stack ? this._stack.sctp : null; }
}

/** ICE candidate init shape (subset of the W3C dictionary). */
interface RTCIceCandidateInit {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}
