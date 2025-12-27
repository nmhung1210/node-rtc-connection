/**
 * @file RTCPeerConnection.js
 * @description WebRTC Peer Connection implementation
 * @module peerconnection/RTCPeerConnection
 * 
 * Ported from Chromium's RTCPeerConnection implementation:
 * - cc/rtc_peer_connection.idl
 * - cc/rtc_peer_connection.h
 */

'use strict';

const EventEmitter = require('events');
const { RTCIceTransport } = require('../ice/RTCIceTransport');
const { RTCDtlsTransport } = require('../dtls/RTCDtlsTransport');
const { RTCSctpTransport } = require('../sctp/RTCSctpTransport');
const { RTCDataChannel } = require('../datachannel/RTCDataChannel');
const RTCCertificate = require('../dtls/RTCCertificate');
const { RTCSessionDescription, RTCSdpType } = require('../sdp/RTCSessionDescription');
const sdpUtils = require('../sdp/sdp-utils');
const { DataChannelTransport } = require('../network/network-transport');

/**
 * RTCSignalingState - Signaling state of the peer connection
 * @readonly
 * @enum {string}
 */
const RTCSignalingState = Object.freeze({
  STABLE: 'stable',
  HAVE_LOCAL_OFFER: 'have-local-offer',
  HAVE_REMOTE_OFFER: 'have-remote-offer',
  HAVE_LOCAL_PRANSWER: 'have-local-pranswer',
  HAVE_REMOTE_PRANSWER: 'have-remote-pranswer',
  CLOSED: 'closed'
});

/**
 * RTCIceGatheringState - ICE gathering state
 * @readonly
 * @enum {string}
 */
const RTCIceGatheringState = Object.freeze({
  NEW: 'new',
  GATHERING: 'gathering',
  COMPLETE: 'complete'
});

/**
 * RTCPeerConnectionState - Overall connection state
 * @readonly
 * @enum {string}
 */
const RTCPeerConnectionState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed'
});

/**
 * @class RTCPeerConnection
 * @extends EventEmitter
 * @description Main class for WebRTC peer-to-peer connections
 * 
 * Events:
 * - 'negotiationneeded': Negotiation is needed
 * - 'icecandidate': New ICE candidate gathered
 * - 'icegatheringstatechange': ICE gathering state changed
 * - 'iceconnectionstatechange': ICE connection state changed
 * - 'connectionstatechange': Overall connection state changed
 * - 'signalingstatechange': Signaling state changed
 * - 'datachannel': New data channel received
 * 
 * @example
 * const pc = new RTCPeerConnection({
 *   iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
 * });
 * 
 * const channel = pc.createDataChannel('myChannel');
 * const offer = await pc.createOffer();
 * await pc.setLocalDescription(offer);
 */
class RTCPeerConnection extends EventEmitter {
  /**
   * Create an RTCPeerConnection instance.
   * @param {Object} [configuration] - Configuration options
   * @param {Array<Object>} [configuration.iceServers] - STUN/TURN servers
   * @param {string} [configuration.iceTransportPolicy='all'] - ICE transport policy
   * @param {string} [configuration.bundlePolicy='balanced'] - Bundle policy
   */
  constructor(configuration = {}) {
    super();

    this._configuration = configuration;
    this._signalingState = RTCSignalingState.STABLE;
    this._iceGatheringState = RTCIceGatheringState.NEW;
    this._connectionState = RTCPeerConnectionState.NEW;
    
    this._localDescription = null;
    this._remoteDescription = null;
    this._pendingLocalDescription = null;
    this._pendingRemoteDescription = null;
    
    this._dataChannels = new Map();
    this._nextChannelId = 0;
    
    // Transport components
    this._certificate = null;
    this._iceTransport = null;
    this._dtlsTransport = null;
    this._sctpTransport = null;
    this._networkTransport = null;
    
    this._isClosed = false;
    this._localIceCandidates = [];
    this._remoteIceCandidates = [];
    
    // Network state
    this._isOfferer = false;
    this._remoteConnectionInfo = null;
    
    // Initialize transports lazily
    this._initializePromise = null;
  }

  /**
   * Initialize transports (lazy initialization)
   * @private
   */
  async _initialize() {
    if (this._initializePromise) {
      return this._initializePromise;
    }

    this._initializePromise = (async () => {
      // Generate certificate if not provided
      if (!this._certificate) {
        this._certificate = await RTCCertificate.generateCertificate({
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          hash: 'SHA-256'
        });
      }

      // Create transport stack
      this._iceTransport = new RTCIceTransport();
      this._dtlsTransport = new RTCDtlsTransport(this._iceTransport, [this._certificate]);
      this._sctpTransport = new RTCSctpTransport(this._dtlsTransport);
      
      // Create network transport
      this._networkTransport = new DataChannelTransport();

      // Setup event handlers
      this._setupTransportEvents();
      this._setupNetworkTransport();
    })();

    return this._initializePromise;
  }

  /**
   * Setup transport event handlers
   * @private
   */
  _setupTransportEvents() {
    // ICE events
    this._iceTransport.on('icecandidate', (candidate) => {
      const candidateInit = {
        candidate: candidate.candidate,
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: candidate.usernameFragment
      };
      this._localIceCandidates.push(candidateInit);
      this.emit('icecandidate', { candidate: candidateInit });
    });

    this._iceTransport.on('gatheringstatechange', () => {
      const state = this._iceTransport.gatheringState;
      this._iceGatheringState = state;
      this.emit('icegatheringstatechange');
    });

    this._iceTransport.on('statechange', () => {
      this._updateConnectionState();
      this.emit('iceconnectionstatechange');
    });

    // DTLS events
    this._dtlsTransport.on('statechange', () => {
      this._updateConnectionState();
    });

    // SCTP events
    this._sctpTransport.on('statechange', () => {
      this._updateConnectionState();
    });
  }

  /**
   * Setup network transport event handlers
   * @private
   */
  _setupNetworkTransport() {
    this._networkTransport.on('message', (message, rinfo) => {
      this._handleIncomingMessage(message, rinfo);
    });

    this._networkTransport.on('connection', (connectionId, rinfo) => {
      // Connection established - open data channels
      setImmediate(() => {
        this._openDataChannels();
      });
    });

    this._networkTransport.on('error', (error) => {
      console.error('Network transport error:', error);
    });
  }

  /**
   * Open all data channels
   * @private
   */
  _openDataChannels() {
    // Check if network transport has active connections
    const hasConnections = this._networkTransport && 
                          this._networkTransport.tcpTransport && 
                          this._networkTransport.tcpTransport.connections.size > 0;
    
    if (!hasConnections) {
      // Network not ready yet, channels will be opened when connection establishes
      return;
    }

    for (const channel of this._dataChannels.values()) {
      if (channel.readyState === 'connecting') {
        this._connectChannelToNetwork(channel);
        channel._setStateToOpen();
      }
    }
  }

  /**
   * Handle incoming network message
   * @private
   */
  _handleIncomingMessage(message, rinfo) {
    try {
      // Try to parse as JSON first (for data channel messages)
      const data = JSON.parse(message.toString());
      
      if (data.type === 'datachannel') {
        const channelLabel = data.label;
        const channelData = data.data;

        // Find or create data channel
        let channel = Array.from(this._dataChannels.values())
          .find(ch => ch.label === channelLabel);

        if (!channel) {
          // Remote peer created a new data channel
          channel = new RTCDataChannel(channelLabel, {
            id: data.id || this._nextChannelId++
          });
          this._dataChannels.set(channel.id, channel);
          
          // Connect channel to network before opening
          this._connectChannelToNetwork(channel);
          
          channel._setStateToOpen();
          this.emit('datachannel', { channel });
        }

        // Deliver message to channel
        if (channel.readyState === 'open') {
          channel._receiveMessage(channelData);
        }
      }
    } catch (error) {
      // Not JSON, might be raw binary data
      console.error('Error parsing network message:', error);
    }
  }

  /**
   * Update overall connection state based on transport states
   * @private
   */
  _updateConnectionState() {
    if (this._isClosed) {
      this._connectionState = RTCPeerConnectionState.CLOSED;
      this.emit('connectionstatechange');
      return;
    }

    const iceState = this._iceTransport?.state || 'new';
    const dtlsState = this._dtlsTransport?.state || 'new';
    const sctpState = this._sctpTransport?.state || 'connecting';

    let newState;

    if (iceState === 'failed' || dtlsState === 'failed') {
      newState = RTCPeerConnectionState.FAILED;
    } else if (iceState === 'connected' && dtlsState === 'connected' && sctpState === 'connected') {
      newState = RTCPeerConnectionState.CONNECTED;
    } else if (iceState === 'checking' || dtlsState === 'connecting' || sctpState === 'connecting') {
      newState = RTCPeerConnectionState.CONNECTING;
    } else if (iceState === 'disconnected') {
      newState = RTCPeerConnectionState.DISCONNECTED;
    } else {
      newState = RTCPeerConnectionState.NEW;
    }

    if (newState !== this._connectionState) {
      this._connectionState = newState;
      this.emit('connectionstatechange');
    }
  }

  /**
   * Create a data channel.
   * @param {string} label - Channel label
   * @param {Object} [options] - Channel options
   * @returns {RTCDataChannel} Data channel
   */
  createDataChannel(label, options = {}) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }

    const channelOptions = {
      ...options,
      negotiated: options.negotiated || false
    };

    if (!channelOptions.negotiated) {
      channelOptions.id = this._nextChannelId++;
    }

    const channel = new RTCDataChannel(label, channelOptions);
    this._dataChannels.set(channelOptions.id, channel);

    // Emit negotiation needed
    setImmediate(() => {
      if (!this._isClosed) {
        this.emit('negotiationneeded');
      }
    });

    return channel;
  }

  /**
   * Create an SDP offer.
   * @param {Object} [options] - Offer options
   * @returns {Promise<RTCSessionDescription>} Offer description
   */
  async createOffer(options = {}) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }

    await this._initialize();

    // Start listening to get actual port
    const { address, port } = await this._networkTransport.listen(0, '0.0.0.0');
    
    // Get local address (try to find non-localhost)
    const os = require('os');
    const interfaces = os.networkInterfaces();
    let localAddress = '127.0.0.1';
    
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localAddress = addr.address;
          break;
        }
      }
      if (localAddress !== '127.0.0.1') break;
    }

    // Generate ICE credentials
    const iceCredentials = sdpUtils.generateIceCredentials();

    // Get fingerprints
    const fingerprints = this._certificate.getFingerprints();

    // Generate SDP offer with actual connection info
    const sdp = sdpUtils.generateOffer({
      iceUfrag: iceCredentials.usernameFragment,
      icePwd: iceCredentials.password,
      fingerprints,
      candidates: this._localIceCandidates,
      setup: 'actpass',
      connectionAddress: localAddress,
      connectionPort: port
    });

    return new RTCSessionDescription({
      type: RTCSdpType.OFFER,
      sdp
    });
  }

  /**
   * Create an SDP answer.
   * @param {Object} [options] - Answer options
   * @returns {Promise<RTCSessionDescription>} Answer description
   */
  async createAnswer(options = {}) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }

    if (!this._remoteDescription || this._remoteDescription.type !== 'offer') {
      throw new Error('Cannot create answer without remote offer');
    }

    await this._initialize();

    // Generate ICE credentials
    const iceCredentials = sdpUtils.generateIceCredentials();

    // Get fingerprints
    const fingerprints = this._certificate.getFingerprints();

    // Generate SDP answer
    const sdp = sdpUtils.generateAnswer({
      iceUfrag: iceCredentials.usernameFragment,
      icePwd: iceCredentials.password,
      fingerprints,
      candidates: this._localIceCandidates,
      setup: 'active'
    });

    return new RTCSessionDescription({
      type: RTCSdpType.ANSWER,
      sdp
    });
  }

  /**
   * Set the local description.
   * @param {RTCSessionDescription} [description] - Local description
   * @returns {Promise<void>}
   */
  async setLocalDescription(description) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }

    // If no description provided, create one based on signaling state
    if (!description) {
      if (this._signalingState === RTCSignalingState.HAVE_REMOTE_OFFER) {
        description = await this.createAnswer();
      } else {
        description = await this.createOffer();
      }
    }

    await this._initialize();

    this._localDescription = new RTCSessionDescription(description);
    this._pendingLocalDescription = this._localDescription;

    // Update signaling state
    if (description.type === 'offer') {
      this._signalingState = RTCSignalingState.HAVE_LOCAL_OFFER;
    } else if (description.type === 'answer') {
      this._signalingState = RTCSignalingState.STABLE;
      this._pendingLocalDescription = null;
      
      // Answerer: start connection when setting local answer
      if (this._remoteDescription) {
        const iceParams = sdpUtils.parseIceParameters(this._remoteDescription.sdp);
        const dtlsParams = sdpUtils.parseDtlsParameters(this._remoteDescription.sdp);
        const sctpParams = sdpUtils.parseSctpParameters(this._remoteDescription.sdp);
        await this._startConnection(iceParams, dtlsParams, sctpParams);
      }
    }

    // Parse and apply ICE parameters
    const iceParams = sdpUtils.parseIceParameters(description.sdp);
    
    // Start ICE gathering with configured servers
    this._iceGatheringState = RTCIceGatheringState.GATHERING;
    this.emit('icegatheringstatechange');
    
    // Gather candidates with ICE servers
    if (this._iceTransport) {
      await this._iceTransport.gather({
        iceServers: this._configuration.iceServers || []
      });
    }

    this.emit('signalingstatechange');
  }

  /**
   * Set the remote description.
   * @param {RTCSessionDescription} description - Remote description
   * @returns {Promise<void>}
   */
  async setRemoteDescription(description) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }

    if (!description || !description.sdp) {
      throw new Error('Invalid session description');
    }

    await this._initialize();

    this._remoteDescription = new RTCSessionDescription(description);
    this._pendingRemoteDescription = this._remoteDescription;

    // Update signaling state
    if (description.type === 'offer') {
      this._signalingState = RTCSignalingState.HAVE_REMOTE_OFFER;
    } else if (description.type === 'answer') {
      this._signalingState = RTCSignalingState.STABLE;
      this._pendingRemoteDescription = null;
      this._pendingLocalDescription = null;
    }

    // Parse remote parameters
    const iceParams = sdpUtils.parseIceParameters(description.sdp);
    const dtlsParams = sdpUtils.parseDtlsParameters(description.sdp);
    const sctpParams = sdpUtils.parseSctpParameters(description.sdp);

    // Parse remote candidates and extract connection info
    const remoteCandidates = sdpUtils.parseCandidates(description.sdp);
    this._remoteIceCandidates = remoteCandidates;
    
    // Extract connection info from SDP
    this._extractConnectionInfo(description.sdp);

    this.emit('signalingstatechange');

    // Start connection establishment if we have both descriptions
    if (this._signalingState === RTCSignalingState.STABLE) {
      await this._startConnection(iceParams, dtlsParams, sctpParams);
    }
  }

  /**
   * Extract connection information from SDP
   * @param {string} sdp - SDP string
   * @private
   */
  _extractConnectionInfo(sdp) {
    // Look for connection line: c=IN IP4 <address>
    const cLineMatch = sdp.match(/^c=IN IP4 ([^\s]+)/m);
    if (cLineMatch && cLineMatch[1] !== '0.0.0.0') {
      const address = cLineMatch[1];
      
      // Look for port in media line: m=application <port>
      const mLineMatch = sdp.match(/^m=application (\d+)/m);
      if (mLineMatch && mLineMatch[1] !== '9') {
        const port = parseInt(mLineMatch[1], 10);
        this._remoteConnectionInfo = { address, port };
      }
    }
  }

  /**
   * Start connection establishment
   * @param {Object} iceParams - ICE parameters
   * @param {Object} dtlsParams - DTLS parameters
   * @param {Object} sctpParams - SCTP parameters
   * @private
   */
  async _startConnection(iceParams, dtlsParams, sctpParams) {
    // Determine if we're the offerer based on setup attribute
    this._isOfferer = this._localDescription?.type === 'offer';

    // Start network transport
    try {
      if (this._isOfferer) {
        // Offerer already started listening in createOffer()
        // Wait for incoming connection
      } else {
        // Answerer connects to offerer
        if (this._remoteConnectionInfo) {
          await this._networkTransport.connect(
            this._remoteConnectionInfo.address,
            this._remoteConnectionInfo.port
          );
          
          // Connection established - open channels
          setImmediate(() => {
            this._openDataChannels();
          });
        }
      }
    } catch (error) {
      console.error('Failed to establish network connection:', error);
    }

    // Start ICE
    if (iceParams.usernameFragment && iceParams.password) {
      try {
        await this._iceTransport.start(iceParams, this._isOfferer ? 'controlling' : 'controlled');
      } catch (error) {
        console.error('Failed to start ICE:', error);
      }
    }

    // Add remote candidates
    for (const candidate of this._remoteIceCandidates) {
      try {
        // Parse candidate string (simplified)
        await this._iceTransport.addRemoteCandidate(candidate);
      } catch (error) {
        console.error('Failed to add remote candidate:', error);
      }
    }

    // Open data channels when connection is established
    this._sctpTransport.once('statechange', () => {
      if (this._sctpTransport.state === 'connected') {
        // Wait for network to be ready before opening channels
        this._openDataChannels();
      }
    });
  }

  /**
   * Connect data channel to network transport
   * @param {RTCDataChannel} channel - Data channel
   * @private
   */
  _connectChannelToNetwork(channel) {
    // Store original _send method
    const originalInternalSend = channel._send ? channel._send.bind(channel) : null;
    
    // Override the internal send to use network transport
    channel._send = async (data) => {
      try {
        const message = JSON.stringify({
          type: 'datachannel',
          label: channel.label,
          id: channel.id,
          data: data
        });
        await this._networkTransport.sendMessage(message);
        
        // Update buffered amount tracking
        if (channel._bufferedAmount > 0) {
          channel._bufferedAmount = Math.max(0, channel._bufferedAmount - (typeof data === 'string' ? data.length : 0));
          channel._emitBufferedAmountLow();
        }
      } catch (error) {
        console.error('Failed to send via network:', error);
        throw error;
      }
    };
  }

  /**
   * Add an ICE candidate.
   * @param {Object} [candidate] - ICE candidate
   * @returns {Promise<void>}
   */
  async addIceCandidate(candidate) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }

    if (!candidate) {
      // End of candidates signal
      this._iceGatheringState = RTCIceGatheringState.COMPLETE;
      this.emit('icegatheringstatechange');
      return;
    }

    await this._initialize();

    if (this._iceTransport) {
      this._remoteIceCandidates.push(candidate);
      
      // If connection is already started, add candidate immediately
      if (this._remoteDescription) {
        try {
          await this._iceTransport.addRemoteCandidate(candidate);
        } catch (error) {
          console.error('Failed to add ICE candidate:', error);
        }
      }
    }
  }

  /**
   * Get the current configuration.
   * @returns {Object} Configuration
   */
  getConfiguration() {
    return { ...this._configuration };
  }

  /**
   * Set the configuration.
   * @param {Object} configuration - New configuration
   */
  setConfiguration(configuration) {
    if (this._isClosed) {
      throw new Error('RTCPeerConnection is closed');
    }
    this._configuration = { ...configuration };
  }

  /**
   * Close the peer connection.
   */
  close() {
    if (this._isClosed) {
      return;
    }

    this._isClosed = true;
    this._signalingState = RTCSignalingState.CLOSED;
    this._connectionState = RTCPeerConnectionState.CLOSED;

    // Close all data channels
    for (const channel of this._dataChannels.values()) {
      channel.close();
    }

    // Close transports
    if (this._sctpTransport) {
      this._sctpTransport.close();
    }
    if (this._dtlsTransport) {
      this._dtlsTransport.close();
    }
    if (this._iceTransport) {
      this._iceTransport.stop();
    }

    this.emit('signalingstatechange');
    this.emit('connectionstatechange');
  }

  /**
   * Get the signaling state.
   * @returns {string} Signaling state
   */
  get signalingState() {
    return this._signalingState;
  }

  /**
   * Get the ICE gathering state.
   * @returns {string} ICE gathering state
   */
  get iceGatheringState() {
    return this._iceGatheringState;
  }

  /**
   * Get the ICE connection state.
   * @returns {string} ICE connection state
   */
  get iceConnectionState() {
    return this._iceTransport?.state || 'new';
  }

  /**
   * Get the overall connection state.
   * @returns {string} Connection state
   */
  get connectionState() {
    return this._connectionState;
  }

  /**
   * Get the local description.
   * @returns {RTCSessionDescription|null} Local description
   */
  get localDescription() {
    return this._localDescription;
  }

  /**
   * Get the remote description.
   * @returns {RTCSessionDescription|null} Remote description
   */
  get remoteDescription() {
    return this._remoteDescription;
  }

  /**
   * Get the current local description.
   * @returns {RTCSessionDescription|null} Current local description
   */
  get currentLocalDescription() {
    return this._signalingState === RTCSignalingState.STABLE ? this._localDescription : null;
  }

  /**
   * Get the pending local description.
   * @returns {RTCSessionDescription|null} Pending local description
   */
  get pendingLocalDescription() {
    return this._pendingLocalDescription;
  }

  /**
   * Get the current remote description.
   * @returns {RTCSessionDescription|null} Current remote description
   */
  get currentRemoteDescription() {
    return this._signalingState === RTCSignalingState.STABLE ? this._remoteDescription : null;
  }

  /**
   * Get the pending remote description.
   * @returns {RTCSessionDescription|null} Pending remote description
   */
  get pendingRemoteDescription() {
    return this._pendingRemoteDescription;
  }

  /**
   * Check if ICE candidate trickling is supported.
   * @returns {boolean} Always true
   */
  get canTrickleIceCandidates() {
    return true;
  }

  /**
   * Get the SCTP transport.
   * @returns {RTCSctpTransport|null} SCTP transport
   */
  get sctp() {
    return this._sctpTransport;
  }
}

module.exports = {
  RTCPeerConnection,
  RTCSignalingState,
  RTCIceGatheringState,
  RTCPeerConnectionState
};
