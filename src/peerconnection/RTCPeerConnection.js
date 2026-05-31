/**
 * @file RTCPeerConnection.js
 * @description WebRTC peer connection driving a real ICE/DTLS/SCTP/DCEP stack.
 * @module peerconnection/RTCPeerConnection
 *
 * This orchestrates signaling (offer/answer + ICE candidate trickle) on top of
 * src/transport-stack.js, which implements the actual on-the-wire protocols.
 * It interoperates with browser RTCPeerConnection for data channels.
 */

'use strict';

const EventEmitter = require('events');
const RTCCertificate = require('../dtls/RTCCertificate');
const { RTCSessionDescription, RTCSdpType } = require('../sdp/RTCSessionDescription');
const { RTCDataChannel, RTCDataChannelState } = require('../datachannel/RTCDataChannel');
const sdpUtils = require('../sdp/sdp-utils');
const { TransportStack } = require('../transport-stack');

const RTCSignalingState = Object.freeze({
  STABLE: 'stable',
  HAVE_LOCAL_OFFER: 'have-local-offer',
  HAVE_REMOTE_OFFER: 'have-remote-offer',
  HAVE_LOCAL_PRANSWER: 'have-local-pranswer',
  HAVE_REMOTE_PRANSWER: 'have-remote-pranswer',
  CLOSED: 'closed',
});

const RTCIceGatheringState = Object.freeze({ NEW: 'new', GATHERING: 'gathering', COMPLETE: 'complete' });

const RTCPeerConnectionState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

class RTCPeerConnection extends EventEmitter {
  constructor(configuration = {}) {
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

  async _ensureCertificate() {
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
  _createStack(iceRole, dtlsRole) {
    if (this._stack) return this._stack;

    const stack = new TransportStack({
      iceRole,
      dtlsRole,
      localUfrag: this._localIce.usernameFragment,
      localPwd: this._localIce.password,
      certDer: this._certificate.getCertificateDer(),
      privateKey: this._certificate.getPrivateKeyObject(),
      verifyFingerprint: (fp) => this._verifyRemoteFingerprint(fp),
    });

    stack.on('candidate', (c) => {
      const init = { candidate: c.sdp, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: this._localIce.usernameFragment };
      this._localCandidates.push(init);
      this.emit('icecandidate', { candidate: init });
    });

    stack.on('iceconnected', () => this._setConnectionState(RTCPeerConnectionState.CONNECTING));
    stack.on('sctpconnected', () => this._setConnectionState(RTCPeerConnectionState.CONNECTED));
    stack.on('error', (e) => {
      this.emit('error', e);
      this._setConnectionState(RTCPeerConnectionState.FAILED);
    });
    stack.on('close', () => this._setConnectionState(RTCPeerConnectionState.DISCONNECTED));

    // Inbound (remotely-initiated) data channels.
    stack.on('datachannel-request', (info) => {
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

  _verifyRemoteFingerprint(fp) {
    if (this._remoteFingerprints.length === 0) return true; // not yet known
    return this._remoteFingerprints.some(
      (rf) => rf.algorithm === fp.algorithm && rf.value.toUpperCase() === fp.value.toUpperCase()
    );
  }

  // ---- data channels ------------------------------------------------------

  createDataChannel(label, options = {}) {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    const channel = new RTCDataChannel(label, options);
    this._channels.add(channel);

    const init = {
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

  async createOffer() {
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

  async createAnswer() {
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

  _pickFingerprint() {
    const fps = this._certificate.getFingerprints();
    return fps.find((f) => f.algorithm === 'sha-256') || fps[0];
  }

  async setLocalDescription(description) {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    if (!description) {
      description = this._signalingState === RTCSignalingState.HAVE_REMOTE_OFFER
        ? await this.createAnswer()
        : await this.createOffer();
    }
    await this._ensureCertificate();
    this._localDescription = new RTCSessionDescription(description);

    if (description.type === 'offer') {
      this._signalingState = RTCSignalingState.HAVE_LOCAL_OFFER;
    } else if (description.type === 'answer') {
      this._signalingState = RTCSignalingState.STABLE;
    }

    // Determine roles and bring up the stack so we start gathering immediately.
    this._setupRolesAndStack(description, /*local*/ true);

    this._iceGatheringState = RTCIceGatheringState.GATHERING;
    this.emit('icegatheringstatechange');
    if (this._stack) {
      await this._stack.gather();
      this._iceGatheringState = RTCIceGatheringState.COMPLETE;
      this.emit('icegatheringstatechange');
      // Signal end-of-candidates.
      this.emit('icecandidate', { candidate: null });
      this._maybeStartChecks();
    }
    this.emit('signalingstatechange');
  }

  async setRemoteDescription(description) {
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
    this._remoteSetup = dtls.setup;

    this._setupRolesAndStack(description, /*local*/ false);

    // Apply remote credentials + any in-SDP candidates, then start checks.
    if (this._stack && this._remoteIce.usernameFragment) {
      this._stack.setRemote(this._remoteIce.usernameFragment, this._remoteIce.password);
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
  _setupRolesAndStack(description, isLocal) {
    if (this._stack) return;

    const iceRole = this._isOfferer ? 'controlling' : 'controlled';

    // Determine our DTLS role.
    let dtlsRole;
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

  _maybeStartChecks() {
    // Once both local gathering started and remote creds exist, checks run.
    if (this._stack && this._remoteIce && this._remoteIce.usernameFragment) {
      this._stack.setRemote(this._remoteIce.usernameFragment, this._remoteIce.password);
    }
  }

  async addIceCandidate(candidate) {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    if (!candidate || candidate.candidate === '') {
      return; // end-of-candidates
    }
    const parsed = sdpUtils.parseCandidateLine(candidate.candidate || candidate);
    if (parsed && this._stack) {
      this._stack.addRemoteCandidate(parsed);
    }
  }

  // ---- state --------------------------------------------------------------

  _setConnectionState(state) {
    if (this._connectionState !== state) {
      this._connectionState = state;
      this.emit('connectionstatechange');
      this.emit('iceconnectionstatechange');
    }
  }

  getConfiguration() { return { ...this._configuration }; }
  setConfiguration(configuration) {
    if (this._isClosed) throw new Error('RTCPeerConnection is closed');
    this._configuration = { ...configuration };
  }

  close() {
    if (this._isClosed) return;
    this._isClosed = true;
    this._signalingState = RTCSignalingState.CLOSED;
    for (const channel of this._channels) {
      try { channel.close(); } catch (_) {}
    }
    if (this._stack) try { this._stack.close(); } catch (_) {}
    this._setConnectionState(RTCPeerConnectionState.CLOSED);
    this.emit('signalingstatechange');
  }

  get signalingState() { return this._signalingState; }
  get iceGatheringState() { return this._iceGatheringState; }
  get iceConnectionState() {
    return this._connectionState === RTCPeerConnectionState.CONNECTED ? 'connected'
      : this._connectionState === RTCPeerConnectionState.CONNECTING ? 'checking'
      : this._connectionState === RTCPeerConnectionState.FAILED ? 'failed'
      : 'new';
  }
  get connectionState() { return this._connectionState; }
  get localDescription() { return this._localDescription; }
  get remoteDescription() { return this._remoteDescription; }
  get currentLocalDescription() { return this._localDescription; }
  get currentRemoteDescription() { return this._remoteDescription; }
  get pendingLocalDescription() { return this._signalingState === RTCSignalingState.STABLE ? null : this._localDescription; }
  get pendingRemoteDescription() { return this._signalingState === RTCSignalingState.STABLE ? null : this._remoteDescription; }
  get canTrickleIceCandidates() { return true; }
  get sctp() { return this._stack ? this._stack.sctp : null; }
}

module.exports = {
  RTCPeerConnection,
  RTCSignalingState,
  RTCIceGatheringState,
  RTCPeerConnectionState,
};
