const EventEmitter = require('events');
const RTCDataChannel = require('./RTCDataChannel');
const RTCSessionDescription = require('./RTCSessionDescription');
const RTCIceCandidate = require('./RTCIceCandidate');

/**
 * RTCPeerConnection represents a WebRTC connection between the local computer and a remote peer.
 * This is a DataChannel-only implementation ported from Chromium.
 */
class RTCPeerConnection extends EventEmitter {
  constructor(configuration, nativePeerConnectionFactory) {
    super();
    
    this._configuration = this._parseConfiguration(configuration || {});
    this._signalingState = 'stable';
    this._iceGatheringState = 'new';
    this._iceConnectionState = 'new';
    this._connectionState = 'new';
    this._pendingLocalDescription = null;
    this._currentLocalDescription = null;
    this._pendingRemoteDescription = null;
    this._currentRemoteDescription = null;
    this._dataChannels = new Map();
    this._closed = false;
    
    // Native peer connection (would be native WebRTC binding)
    this._nativePeerConnection = null;
    this._nativePeerConnectionFactory = nativePeerConnectionFactory;
    
    // Initialize native peer connection
    this._initializeNativePeerConnection();
  }

  /**
   * Parse and validate configuration
   * @private
   */
  _parseConfiguration(config) {
    const configuration = {
      iceServers: [],
      iceTransportPolicy: 'all',
      bundlePolicy: 'balanced',
      rtcpMuxPolicy: 'require',
      iceCandidatePoolSize: 0
    };

    if (config.iceServers) {
      configuration.iceServers = config.iceServers.map(server => ({
        urls: Array.isArray(server.urls) ? server.urls : [server.urls],
        username: server.username || '',
        credential: server.credential || ''
      }));
    }

    if (config.iceTransportPolicy) {
      configuration.iceTransportPolicy = config.iceTransportPolicy;
    }

    if (config.bundlePolicy) {
      configuration.bundlePolicy = config.bundlePolicy;
    }

    if (config.rtcpMuxPolicy) {
      configuration.rtcpMuxPolicy = config.rtcpMuxPolicy;
    }

    if (config.iceCandidatePoolSize !== undefined) {
      configuration.iceCandidatePoolSize = config.iceCandidatePoolSize;
    }

    return configuration;
  }

  /**
   * Initialize native peer connection with factory
   * @private
   */
  _initializeNativePeerConnection() {
    if (!this._nativePeerConnectionFactory) {
      throw new Error('Native PeerConnection factory not provided');
    }

    // Create native peer connection
    this._nativePeerConnection = this._nativePeerConnectionFactory.createPeerConnection(
      this._configuration
    );

    if (!this._nativePeerConnection) {
      throw new Error('Failed to create native peer connection');
    }

    // Setup observers
    this._setupObservers();
  }

  /**
   * Setup observers for native peer connection events
   * @private
   */
  _setupObservers() {
    if (!this._nativePeerConnection) {
      return;
    }

    // Signaling state change
    this._nativePeerConnection.on('signalingstatechange', (state) => {
      this._signalingState = this._convertSignalingState(state);
      this.emit('signalingstatechange');
    });

    // ICE connection state change
    this._nativePeerConnection.on('iceconnectionstatechange', (state) => {
      this._iceConnectionState = this._convertIceConnectionState(state);
      this.emit('iceconnectionstatechange');
    });

    // ICE gathering state change
    this._nativePeerConnection.on('icegatheringstatechange', (state) => {
      this._iceGatheringState = this._convertIceGatheringState(state);
      this.emit('icegatheringstatechange');
    });

    // Connection state change
    this._nativePeerConnection.on('connectionstatechange', (state) => {
      this._connectionState = this._convertConnectionState(state);
      this.emit('connectionstatechange');
    });

    // ICE candidate
    this._nativePeerConnection.on('icecandidate', (candidate) => {
      const iceCandidate = candidate ? new RTCIceCandidate(candidate) : null;
      this.emit('icecandidate', { candidate: iceCandidate });
    });

    // Data channel (remote)
    this._nativePeerConnection.on('datachannel', (nativeChannel) => {
      const dataChannel = new RTCDataChannel(nativeChannel, this);
      this._dataChannels.set(dataChannel.label, dataChannel);
      this.emit('datachannel', { channel: dataChannel });
    });

    // Negotiation needed
    this._nativePeerConnection.on('negotiationneeded', () => {
      this.emit('negotiationneeded');
    });
  }

  /**
   * The current signaling state
   */
  get signalingState() {
    return this._signalingState;
  }

  /**
   * The current ICE gathering state
   */
  get iceGatheringState() {
    return this._iceGatheringState;
  }

  /**
   * The current ICE connection state
   */
  get iceConnectionState() {
    return this._iceConnectionState;
  }

  /**
   * The current connection state
   */
  get connectionState() {
    return this._connectionState;
  }

  /**
   * The local description
   */
  get localDescription() {
    return this._currentLocalDescription || this._pendingLocalDescription;
  }

  /**
   * The remote description
   */
  get remoteDescription() {
    return this._currentRemoteDescription || this._pendingRemoteDescription;
  }

  /**
   * The pending local description
   */
  get pendingLocalDescription() {
    return this._pendingLocalDescription;
  }

  /**
   * The pending remote description
   */
  get pendingRemoteDescription() {
    return this._pendingRemoteDescription;
  }

  /**
   * The current local description
   */
  get currentLocalDescription() {
    return this._currentLocalDescription;
  }

  /**
   * The current remote description
   */
  get currentRemoteDescription() {
    return this._currentRemoteDescription;
  }

  /**
   * Create an offer
   * @param {Object} options - Offer options
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async createOffer(options = {}) {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    try {
      const nativeDescription = await this._nativePeerConnection.createOffer(options);
      return new RTCSessionDescription({
        type: nativeDescription.type,
        sdp: nativeDescription.sdp
      });
    } catch (error) {
      throw new Error(`Failed to create offer: ${error.message}`);
    }
  }

  /**
   * Create an answer
   * @param {Object} options - Answer options
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async createAnswer(options = {}) {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    try {
      const nativeDescription = await this._nativePeerConnection.createAnswer(options);
      return new RTCSessionDescription({
        type: nativeDescription.type,
        sdp: nativeDescription.sdp
      });
    } catch (error) {
      throw new Error(`Failed to create answer: ${error.message}`);
    }
  }

  /**
   * Set the local description
   * @param {RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  async setLocalDescription(description) {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    try {
      await this._nativePeerConnection.setLocalDescription(description);
      
      if (description.type === 'offer') {
        this._pendingLocalDescription = new RTCSessionDescription(description);
      } else if (description.type === 'answer') {
        this._currentLocalDescription = new RTCSessionDescription(description);
        this._pendingLocalDescription = null;
      } else if (description.type === 'rollback') {
        this._pendingLocalDescription = null;
      }
    } catch (error) {
      throw new Error(`Failed to set local description: ${error.message}`);
    }
  }

  /**
   * Set the remote description
   * @param {RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  async setRemoteDescription(description) {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    try {
      await this._nativePeerConnection.setRemoteDescription(description);
      
      if (description.type === 'offer') {
        this._pendingRemoteDescription = new RTCSessionDescription(description);
      } else if (description.type === 'answer') {
        this._currentRemoteDescription = new RTCSessionDescription(description);
        this._pendingRemoteDescription = null;
      } else if (description.type === 'rollback') {
        this._pendingRemoteDescription = null;
      }
    } catch (error) {
      throw new Error(`Failed to set remote description: ${error.message}`);
    }
  }

  /**
   * Add an ICE candidate
   * @param {RTCIceCandidateInit} candidate
   * @returns {Promise<void>}
   */
  async addIceCandidate(candidate) {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    if (!candidate) {
      // End of candidates
      return;
    }

    try {
      await this._nativePeerConnection.addIceCandidate(candidate);
    } catch (error) {
      throw new Error(`Failed to add ICE candidate: ${error.message}`);
    }
  }

  /**
   * Create a data channel
   * @param {string} label - Channel label
   * @param {Object} dataChannelDict - Channel options
   * @returns {RTCDataChannel}
   */
  createDataChannel(label, dataChannelDict = {}) {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    const options = {
      ordered: dataChannelDict.ordered !== undefined ? dataChannelDict.ordered : true,
      maxPacketLifeTime: dataChannelDict.maxPacketLifeTime,
      maxRetransmits: dataChannelDict.maxRetransmits,
      protocol: dataChannelDict.protocol || '',
      negotiated: dataChannelDict.negotiated || false,
      id: dataChannelDict.id
    };

    try {
      const nativeChannel = this._nativePeerConnection.createDataChannel(label, options);
      const dataChannel = new RTCDataChannel(nativeChannel, this);
      this._dataChannels.set(label, dataChannel);
      return dataChannel;
    } catch (error) {
      throw new Error(`Failed to create data channel: ${error.message}`);
    }
  }

  /**
   * Get configuration
   * @returns {Object}
   */
  getConfiguration() {
    return { ...this._configuration };
  }

  /**
   * Set configuration
   * @param {Object} configuration
   */
  setConfiguration(configuration) {
    this._checkClosed();
    this._configuration = this._parseConfiguration(configuration);
    
    if (this._nativePeerConnection) {
      this._nativePeerConnection.setConfiguration(this._configuration);
    }
  }

  /**
   * Close the peer connection
   */
  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._signalingState = 'closed';

    // Close all data channels
    for (const [label, channel] of this._dataChannels) {
      channel.close();
      channel.dispose();
    }
    this._dataChannels.clear();

    // Close native peer connection
    if (this._nativePeerConnection) {
      this._nativePeerConnection.close();
      this._nativePeerConnection.removeAllListeners();
      this._nativePeerConnection = null;
    }

    this.emit('signalingstatechange');
    this.removeAllListeners();
  }

  /**
   * Get stats
   * @returns {Promise<Object>}
   */
  async getStats() {
    this._checkClosed();

    if (!this._nativePeerConnection) {
      throw new Error('Native peer connection not available');
    }

    try {
      return await this._nativePeerConnection.getStats();
    } catch (error) {
      throw new Error(`Failed to get stats: ${error.message}`);
    }
  }

  /**
   * Check if connection is closed
   * @private
   */
  _checkClosed() {
    if (this._closed || this._signalingState === 'closed') {
      throw new Error("The RTCPeerConnection's signalingState is 'closed'");
    }
  }

  /**
   * Convert native signaling state to string
   * @private
   */
  _convertSignalingState(state) {
    const states = ['stable', 'have-local-offer', 'have-remote-offer', 
                   'have-local-pranswer', 'have-remote-pranswer', 'closed'];
    return states[state] || 'stable';
  }

  /**
   * Convert native ICE connection state to string
   * @private
   */
  _convertIceConnectionState(state) {
    const states = ['new', 'checking', 'connected', 'completed', 
                   'failed', 'disconnected', 'closed'];
    return states[state] || 'new';
  }

  /**
   * Convert native ICE gathering state to string
   * @private
   */
  _convertIceGatheringState(state) {
    const states = ['new', 'gathering', 'complete'];
    return states[state] || 'new';
  }

  /**
   * Convert native connection state to string
   * @private
   */
  _convertConnectionState(state) {
    const states = ['new', 'connecting', 'connected', 'disconnected', 
                   'failed', 'closed'];
    return states[state] || 'new';
  }
}

module.exports = RTCPeerConnection;
