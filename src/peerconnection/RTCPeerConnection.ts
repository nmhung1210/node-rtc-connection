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
  #configuration: RTCConfiguration;
  #signalingState: string;
  #iceGatheringState: string;
  #connectionState: string;

  #localDescription: RTCSessionDescription | null;
  #remoteDescription: RTCSessionDescription | null;

  #certificate: RTCCertificate | null;
  #localIce: IceCredentials;
  #remoteIce: sdpUtils.IceParameters | null;
  #remoteFingerprints: Fingerprint[];
  #remoteSetup: string | null;

  #stack: TransportStack | null;
  #isOfferer: boolean;
  #isClosed: boolean;

  #pendingChannels: PendingChannel[];
  #channels: Set<RTCDataChannel>;
  #localCandidates: RTCIceCandidateInit[];

  constructor(configuration: RTCConfiguration = {}) {
    super();
    this.#configuration = configuration;
    this.#signalingState = RTCSignalingState.STABLE;
    this.#iceGatheringState = RTCIceGatheringState.NEW;
    this.#connectionState = RTCPeerConnectionState.NEW;

    this.#localDescription = null;
    this.#remoteDescription = null;

    this.#certificate = null;
    this.#localIce = sdpUtils.generateIceCredentials();
    this.#remoteIce = null;
    this.#remoteFingerprints = [];
    this.#remoteSetup = null;

    this.#stack = null;
    this.#isOfferer = false;
    this.#isClosed = false;

    // Data channels created locally before the stack is ready are queued and
    // opened once SCTP is established.
    this.#pendingChannels = [];
    this.#channels = new Set();
    this.#localCandidates = [];
  }

  // ---- lazy init ----------------------------------------------------------

  async #ensureCertificate(): Promise<RTCCertificate> {
    if (!this.#certificate) {
      if (this.#configuration.certificates && this.#configuration.certificates[0]) {
        this.#certificate = this.#configuration.certificates[0];
      } else {
        this.#certificate = await RTCCertificate.generateCertificate();
      }
    }
    return this.#certificate;
  }

  /**
   * Create the transport stack once roles are known.
   * @param {'controlling'|'controlled'} iceRole
   * @param {'client'|'server'} dtlsRole
   */
  #createStack(iceRole: 'controlling' | 'controlled', dtlsRole: 'client' | 'server'): TransportStack {
    if (this.#stack) return this.#stack;

    const certificate = this.#certificate;
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
      localUfrag: this.#localIce.usernameFragment,
      localPwd: this.#localIce.password,
      certDer,
      privateKey: certificate.getPrivateKeyObject(),
      verifyFingerprint: (fp: { algorithm: string; value: string }) => this.#verifyRemoteFingerprint(fp),
    });

    stack.on('candidate', (c: StackCandidate) => {
      const init: RTCIceCandidateInit = { candidate: c.sdp, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: this.#localIce.usernameFragment };
      this.#localCandidates.push(init);
      this.emit('icecandidate', { candidate: init });
    });

    stack.on('iceconnected', () => this.#setConnectionState(RTCPeerConnectionState.CONNECTING));
    stack.on('sctpconnected', () => this.#setConnectionState(RTCPeerConnectionState.CONNECTED));
    stack.on('error', (e: unknown) => {
      this.emit('error', e);
      this.#setConnectionState(RTCPeerConnectionState.FAILED);
    });
    stack.on('close', () => this.#setConnectionState(RTCPeerConnectionState.DISCONNECTED));

    // Inbound (remotely-initiated) data channels.
    stack.on('datachannel-request', (info: OpenRequestInfo) => {
      const channel = new RTCDataChannel(info.label, {
        ordered: info.ordered,
        protocol: info.protocol,
        id: info.streamId,
      });
      stack.acceptChannel(channel, info);
      this.#channels.add(channel);
      this.emit('datachannel', { channel });
    });

    // Open any queued local channels when SCTP is ready.
    stack.on('ready', () => {
      for (const { channel, init } of this.#pendingChannels) {
        stack.openChannel(channel, init);
      }
      this.#pendingChannels = [];
    });

    this.#stack = stack;
    return stack;
  }

  #verifyRemoteFingerprint(fp: { algorithm: string; value: string }): boolean {
    if (this.#remoteFingerprints.length === 0) return true; // not yet known
    return this.#remoteFingerprints.some(
      (rf) => rf.algorithm === fp.algorithm && rf.value.toUpperCase() === fp.value.toUpperCase()
    );
  }

  // ---- data channels ------------------------------------------------------

  createDataChannel(label: string, options: RTCDataChannelInit = {}): RTCDataChannel {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    const channel = new RTCDataChannel(label, options);
    this.#channels.add(channel);

    const init: RTCDataChannelInit = {
      ordered: options.ordered !== false,
      maxRetransmits: options.maxRetransmits,
      maxPacketLifeTime: options.maxPacketLifeTime,
      protocol: options.protocol || '',
      negotiated: options.negotiated || false,
    };

    if (this.#stack && this.#stack.isReady()) {
      this.#stack.openChannel(channel, init);
    } else {
      this.#pendingChannels.push({ channel, init });
    }

    setImmediate(() => { if (!this.#isClosed) this.emit('negotiationneeded'); });
    return channel;
  }

  // ---- signaling ----------------------------------------------------------

  async createOffer(): Promise<RTCSessionDescription> {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    await this.#ensureCertificate();
    this.#isOfferer = true;

    const fp = this.#pickFingerprint();
    const sdp = sdpUtils.generateOffer({
      iceUfrag: this.#localIce.usernameFragment,
      icePwd: this.#localIce.password,
      fingerprint: fp,
      setup: 'actpass',
      candidates: [],
    });
    return new RTCSessionDescription({ type: RTCSdpType.OFFER, sdp });
  }

  async createAnswer(): Promise<RTCSessionDescription> {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    if (!this.#remoteDescription || this.#remoteDescription.type !== 'offer') {
      throw new Error('Cannot create answer without remote offer');
    }
    await this.#ensureCertificate();

    // Answerer takes the active (DTLS client) role when offer is actpass.
    const fp = this.#pickFingerprint();
    const sdp = sdpUtils.generateAnswer({
      iceUfrag: this.#localIce.usernameFragment,
      icePwd: this.#localIce.password,
      fingerprint: fp,
      setup: 'active',
      candidates: [],
    });
    return new RTCSessionDescription({ type: RTCSdpType.ANSWER, sdp });
  }

  #pickFingerprint(): Fingerprint | undefined {
    const certificate = this.#certificate;
    if (!certificate) {
      throw new Error('Certificate not initialized');
    }
    const fps = certificate.getFingerprints();
    return fps.find((f) => f.algorithm === 'sha-256') || fps[0];
  }

  async setLocalDescription(description?: RTCSessionDescriptionInit | RTCSessionDescription): Promise<void> {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    const desc: RTCSessionDescriptionInit | RTCSessionDescription = description
      ? description
      : this.#signalingState === RTCSignalingState.HAVE_REMOTE_OFFER
        ? await this.createAnswer()
        : await this.createOffer();
    await this.#ensureCertificate();
    this.#localDescription = new RTCSessionDescription({ type: desc.type ?? undefined, sdp: desc.sdp ?? undefined });

    if (desc.type === 'offer') {
      this.#signalingState = RTCSignalingState.HAVE_LOCAL_OFFER;
    } else if (desc.type === 'answer') {
      this.#signalingState = RTCSignalingState.STABLE;
    }

    // Determine roles and bring up the stack so we start gathering immediately.
    this.#setupRolesAndStack(desc, /*local*/ true);

    this.#iceGatheringState = RTCIceGatheringState.GATHERING;
    this.emit('icegatheringstatechange');
    if (this.#stack) {
      await this.#stack.gather({
        iceServers: this.#configuration.iceServers || [],
        iceTransportPolicy: this.#configuration.iceTransportPolicy || 'all',
      });
      this.#iceGatheringState = RTCIceGatheringState.COMPLETE;
      this.emit('icegatheringstatechange');
      // Signal end-of-candidates.
      this.emit('icecandidate', { candidate: null });
      this.#maybeStartChecks();
    }
    this.emit('signalingstatechange');
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    if (!description || !description.sdp) throw new Error('Invalid session description');
    await this.#ensureCertificate();

    this.#remoteDescription = new RTCSessionDescription(description);
    if (description.type === 'offer') {
      this.#signalingState = RTCSignalingState.HAVE_REMOTE_OFFER;
    } else if (description.type === 'answer') {
      this.#signalingState = RTCSignalingState.STABLE;
    }

    this.#remoteIce = sdpUtils.parseIceParameters(description.sdp);
    const dtls = sdpUtils.parseDtlsParameters(description.sdp);
    this.#remoteFingerprints = dtls.fingerprints;
    this.#remoteSetup = dtls.setup ?? null;

    this.#setupRolesAndStack(description, /*local*/ false);

    // Apply remote credentials + any in-SDP candidates, then start checks.
    if (this.#stack && this.#remoteIce.usernameFragment) {
      this.#stack.setRemote(this.#remoteIce.usernameFragment, this.#remoteIce.password ?? '');
      for (const c of sdpUtils.parseCandidates(description.sdp)) {
        this.#stack.addRemoteCandidate(c);
      }
    }
    this.#maybeStartChecks();
    this.emit('signalingstatechange');
  }

  /**
   * Decide ICE controlling/controlled and DTLS client/server, then create the
   * stack. Offerer is ICE-controlling. DTLS roles follow a=setup: the side that
   * ends up 'active' is the DTLS client.
   */
  #setupRolesAndStack(_description: RTCSessionDescriptionInit | RTCSessionDescription, _isLocal: boolean): void {
    if (this.#stack) return;

    const iceRole: 'controlling' | 'controlled' = this.#isOfferer ? 'controlling' : 'controlled';

    // Determine our DTLS role.
    let dtlsRole: 'client' | 'server';
    if (this.#isOfferer) {
      // We offered actpass; the answerer chooses. We learn it from their answer
      // (setup:active => they are client => we are server). Until we see the
      // answer we default to server (passive), which matches answerer=active.
      if (this.#remoteSetup === 'active') dtlsRole = 'server';
      else if (this.#remoteSetup === 'passive') dtlsRole = 'client';
      else dtlsRole = 'server';
    } else {
      // We are the answerer; we chose 'active' in createAnswer => DTLS client.
      dtlsRole = 'client';
    }

    this.#createStack(iceRole, dtlsRole);
  }

  #maybeStartChecks(): void {
    // Once both local gathering started and remote creds exist, checks run.
    if (this.#stack && this.#remoteIce && this.#remoteIce.usernameFragment) {
      this.#stack.setRemote(this.#remoteIce.usernameFragment, this.#remoteIce.password ?? '');
    }
  }

  async addIceCandidate(candidate: RTCIceCandidateInit | string): Promise<void> {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    if (!candidate || (typeof candidate !== 'string' && candidate.candidate === '')) {
      return; // end-of-candidates
    }
    const candidateStr = typeof candidate === 'string' ? candidate : (candidate.candidate || '');
    const parsed = sdpUtils.parseCandidateLine(candidateStr);
    if (parsed && this.#stack) {
      this.#stack.addRemoteCandidate(parsed);
    }
  }

  // ---- state --------------------------------------------------------------

  #setConnectionState(state: string): void {
    if (this.#connectionState !== state) {
      this.#connectionState = state;
      this.emit('connectionstatechange');
      this.emit('iceconnectionstatechange');
    }
  }

  getConfiguration(): RTCConfiguration { return { ...this.#configuration }; }
  setConfiguration(configuration: RTCConfiguration): void {
    if (this.#isClosed) throw new Error('RTCPeerConnection is closed');
    this.#configuration = { ...configuration };
  }

  close(): void {
    if (this.#isClosed) return;
    this.#isClosed = true;
    this.#signalingState = RTCSignalingState.CLOSED;
    for (const channel of this.#channels) {
      try { channel.close(); } catch (_) { /* best-effort */ }
    }
    if (this.#stack) try { this.#stack.close(); } catch (_) { /* best-effort */ }
    this.#setConnectionState(RTCPeerConnectionState.CLOSED);
    this.emit('signalingstatechange');
  }

  get signalingState(): string { return this.#signalingState; }
  get iceGatheringState(): string { return this.#iceGatheringState; }
  get iceConnectionState(): string {
    return this.#connectionState === RTCPeerConnectionState.CONNECTED ? 'connected'
      : this.#connectionState === RTCPeerConnectionState.CONNECTING ? 'checking'
      : this.#connectionState === RTCPeerConnectionState.FAILED ? 'failed'
      : 'new';
  }
  get connectionState(): string { return this.#connectionState; }
  get localDescription(): RTCSessionDescription | null { return this.#localDescription; }
  get remoteDescription(): RTCSessionDescription | null { return this.#remoteDescription; }
  get currentLocalDescription(): RTCSessionDescription | null { return this.#localDescription; }
  get currentRemoteDescription(): RTCSessionDescription | null { return this.#remoteDescription; }
  get pendingLocalDescription(): RTCSessionDescription | null { return this.#signalingState === RTCSignalingState.STABLE ? null : this.#localDescription; }
  get pendingRemoteDescription(): RTCSessionDescription | null { return this.#signalingState === RTCSignalingState.STABLE ? null : this.#remoteDescription; }
  get canTrickleIceCandidates(): boolean { return true; }
  get sctp(): TransportStack['sctp'] { return this.#stack ? this.#stack.sctp : null; }
}

/** ICE candidate init shape (subset of the W3C dictionary). */
interface RTCIceCandidateInit {
  candidate: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
  usernameFragment?: string;
}
