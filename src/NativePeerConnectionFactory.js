const EventEmitter = require('events');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');

/**
 * NativePeerConnectionFactory creates native peer connection instances.
 * Real implementation using Node.js net package for peer-to-peer communication.
 */
class NativePeerConnectionFactory {
  constructor() {
    this._initialized = false;
    this._peerConnections = new Set();
  }

  /**
   * Initialize the factory
   */
  initialize() {
    if (this._initialized) {
      return;
    }

    console.log('[NativePeerConnectionFactory] Initializing with Node.js net package');
    this._initialized = true;
  }

  /**
   * Create a native peer connection
   * @param {Object} configuration - RTCConfiguration
   * @returns {NativePeerConnection}
   */
  createPeerConnection(configuration) {
    if (!this._initialized) {
      this.initialize();
    }

    const nativePC = new NativePeerConnection(configuration);
    this._peerConnections.add(nativePC);
    
    nativePC.on('close', () => {
      this._peerConnections.delete(nativePC);
    });

    return nativePC;
  }

  /**
   * Dispose of the factory and all peer connections
   */
  dispose() {
    for (const pc of this._peerConnections) {
      pc.close();
    }
    this._peerConnections.clear();
    this._initialized = false;
  }
}

/**
 * NativePeerConnection - Real implementation using Node.js net package
 * Implements peer-to-peer connection using TCP for data channels
 */
class NativePeerConnection extends EventEmitter {
  constructor(configuration) {
    super();
    this._configuration = configuration;
    this._signalingState = 0; // stable
    this._iceConnectionState = 0; // new
    this._iceGatheringState = 0; // new
    this._connectionState = 0; // new
    this._localDescription = null;
    this._remoteDescription = null;
    this._dataChannels = new Map();
    this._closed = false;
    
    // Networking components
    this._server = null;
    this._socket = null;
    this._localAddress = null;
    this._localPort = null;
    this._remoteAddress = null;
    this._remotePort = null;
    this._isOfferer = false;
    this._iceUsername = this._generateRandomString(8);
    this._icePassword = this._generateRandomString(24);
    this._fingerprint = this._generateFingerprint();
    
    console.log('[NativePeerConnection] Created with real networking support');
  }

  /**
   * Create an offer
   * @param {Object} options
   * @returns {Promise<{type: string, sdp: string}>}
   */
  async createOffer(options) {
    if (this._closed) {
      throw new Error('PeerConnection is closed');
    }

    this._isOfferer = true;
    
    // Create TCP server to listen for incoming connections
    await this._createServer();
    
    // Generate real SDP with actual network information
    const sdp = this._generateSDP('offer');
    return { type: 'offer', sdp };
  }

  /**
   * Create an answer
   * @param {Object} options
   * @returns {Promise<{type: string, sdp: string}>}
   */
  async createAnswer(options) {
    if (this._closed) {
      throw new Error('PeerConnection is closed');
    }

    if (!this._remoteDescription) {
      throw new Error('No remote description set');
    }

    this._isOfferer = false;
    
    // Create TCP server to listen for incoming connections (if needed)
    if (!this._server) {
      await this._createServer();
    }
    
    // Generate real SDP with actual network information
    const sdp = this._generateSDP('answer');
    return { type: 'answer', sdp };
  }

  /**
   * Set local description
   * @param {Object} description
   * @returns {Promise<void>}
   */
  async setLocalDescription(description) {
    if (this._closed) {
      throw new Error('PeerConnection is closed');
    }

    this._localDescription = description;
    
    // Update signaling state
    if (description.type === 'offer') {
      this._signalingState = 1; // have-local-offer
      this.emit('signalingstatechange', this._signalingState);
    } else if (description.type === 'answer') {
      this._signalingState = 0; // stable
      this.emit('signalingstatechange', this._signalingState);
      
      // If we're answerer and have remote description, connect
      if (!this._isOfferer && this._remoteDescription) {
        await this._connectToPeer();
      }
    }

    // Start real ICE gathering
    this._startIceGathering();
  }

  /**
   * Set remote description
   * @param {Object} description
   * @returns {Promise<void>}
   */
  async setRemoteDescription(description) {
    if (this._closed) {
      throw new Error('PeerConnection is closed');
    }

    // Parse remote SDP to extract connection information
    this._parseSDP(description.sdp);
    this._remoteDescription = description;
    
    // Update signaling state
    if (description.type === 'offer') {
      this._signalingState = 2; // have-remote-offer
      this.emit('signalingstatechange', this._signalingState);
    } else if (description.type === 'answer') {
      this._signalingState = 0; // stable
      this.emit('signalingstatechange', this._signalingState);
      
      // If we're offerer and have local description, connect
      if (this._isOfferer && this._localDescription) {
        await this._connectToPeer();
      }
    }
  }

  /**
   * Add ICE candidate
   * @param {Object} candidate
   * @returns {Promise<void>}
   */
  async addIceCandidate(candidate) {
    if (this._closed) {
      throw new Error('PeerConnection is closed');
    }

    if (!candidate || !candidate.candidate) {
      return;
    }

    // Parse ICE candidate to extract address and port
    const parts = candidate.candidate.split(' ');
    if (parts.length >= 6) {
      this._remoteAddress = parts[4];
      this._remotePort = parseInt(parts[5], 10);
      console.log(`[NativePeerConnection] Remote address: ${this._remoteAddress}:${this._remotePort}`);
      
      // If we have both local and remote info, and we're offerer, connect
      if (this._isOfferer && this._localAddress && this._remoteAddress && 
          this._signalingState === 0 && !this._socket) {
        await this._connectToPeer();
      }
    }
  }

  /**
   * Create a data channel
   * @param {string} label
   * @param {Object} options
   * @returns {NativeDataChannel}
   */
  createDataChannel(label, options) {
    if (this._closed) {
      throw new Error('PeerConnection is closed');
    }

    const channel = new NativeDataChannel(label, options, this);
    this._dataChannels.set(label, channel);
    
    // If socket is already connected, open the channel
    if (this._socket && this._socket.writable) {
      setTimeout(() => channel._setConnected(this._socket), 0);
    }
    
    // Emit negotiation needed
    setTimeout(() => {
      this.emit('negotiationneeded');
    }, 0);

    return channel;
  }

  /**
   * Set configuration
   * @param {Object} configuration
   */
  setConfiguration(configuration) {
    this._configuration = configuration;
  }

  /**
   * Get stats
   * @returns {Promise<Object>}
   */
  async getStats() {
    return {
      type: 'peer-connection',
      timestamp: Date.now(),
      // Mock stats
    };
  }

  /**
   * Close the peer connection
   */
  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._signalingState = 5; // closed
    
    // Close all data channels
    for (const [label, channel] of this._dataChannels) {
      channel.close();
    }
    this._dataChannels.clear();

    // Close socket
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }

    // Close server
    if (this._server) {
      this._server.close();
      this._server = null;
    }

    this.emit('signalingstatechange', this._signalingState);
    this.emit('close');
  }

  /**
   * Create TCP server to listen for incoming connections
   * @private
   */
  async _createServer() {
    return new Promise((resolve, reject) => {
      this._server = net.createServer((socket) => {
        console.log('[NativePeerConnection] Incoming connection accepted');
        this._handleIncomingConnection(socket);
      });

      this._server.listen(0, '0.0.0.0', () => {
        const address = this._server.address();
        this._localPort = address.port;
        this._localAddress = this._getLocalIPAddress();
        console.log(`[NativePeerConnection] Server listening on ${this._localAddress}:${this._localPort}`);
        resolve();
      });

      this._server.on('error', (err) => {
        console.error('[NativePeerConnection] Server error:', err);
        reject(err);
      });
    });
  }

  /**
   * Connect to remote peer
   * @private
   */
  async _connectToPeer() {
    if (!this._remoteAddress || !this._remotePort) {
      console.log('[NativePeerConnection] Cannot connect: missing remote address');
      return;
    }

    if (this._socket) {
      console.log('[NativePeerConnection] Already connected');
      return;
    }

    // Tie-breaking: only connect if our port is higher than remote port
    // This ensures only one peer connects, avoiding the race condition
    if (this._localPort < this._remotePort) {
      console.log(`[NativePeerConnection] Not connecting (local port ${this._localPort} < remote port ${this._remotePort}), waiting for incoming`);
      return;
    }

    console.log(`[NativePeerConnection] Connecting to ${this._remoteAddress}:${this._remotePort}`);
    
    this._socket = new net.Socket();
    
    this._socket.connect(this._remotePort, this._remoteAddress, () => {
      console.log('[NativePeerConnection] Connected to peer');
      this._iceConnectionState = 2; // connected
      this.emit('iceconnectionstatechange', this._iceConnectionState);
      
      // Announce existing data channels to peer and open them
      setImmediate(() => {
        for (const [label, channel] of this._dataChannels) {
          this._sendChannelAnnouncement(label);
          channel._setConnected(this._socket);
        }
      });
    });

    this._setupSocketHandlers(this._socket);
  }

  /**
   * Handle incoming connection from peer
   * @private
   */
  _handleIncomingConnection(socket) {
    if (this._socket) {
      console.log('[NativePeerConnection] Connection already exists, closing new one');
      socket.destroy();
      return;
    }

    console.log('[NativePeerConnection] Accepted connection from peer');
    
    // Setup handlers BEFORE storing socket to avoid missing early data
    this._setupSocketHandlers(socket);
    
    this._socket = socket;
    this._iceConnectionState = 2; // connected
    this.emit('iceconnectionstatechange', this._iceConnectionState);
    
    // Announce existing data channels to peer
    setImmediate(() => {
      for (const [label, channel] of this._dataChannels) {
        this._sendChannelAnnouncement(label);
        channel._setConnected(this._socket);
      }
    });
  }

  /**
   * Setup socket event handlers
   * @private
   */
  _setupSocketHandlers(socket) {
    socket.on('data', (data) => {
      this._handleIncomingData(data);
    });

    socket.on('close', () => {
      console.log('[NativePeerConnection] Connection closed');
      this._iceConnectionState = 6; // closed
      this.emit('iceconnectionstatechange', this._iceConnectionState);
      
      // Close all data channels
      for (const [label, channel] of this._dataChannels) {
        channel._handleDisconnect();
      }
    });

    socket.on('error', (err) => {
      console.error('[NativePeerConnection] Socket error:', err);
      this._iceConnectionState = 4; // failed
      this.emit('iceconnectionstatechange', this._iceConnectionState);
    });
  }

  /**
   * Send channel announcement to peer (empty message to trigger remote channel creation)
   * @private
   */
  _sendChannelAnnouncement(label) {
    if (!this._socket) {
      console.log(`[NativePeerConnection] Cannot announce ${label}: no socket`);
      return;
    }
    
    const labelBuffer = Buffer.from(label, 'utf8');
    const labelLength = labelBuffer.length;
    const emptyData = Buffer.alloc(0);
    
    // Message format: <length:4><label-length:2><label><data>
    // length is the number of bytes after the length field
    const totalLength = 2 + labelLength + emptyData.length;
    const buffer = Buffer.allocUnsafe(4 + totalLength);
    
    buffer.writeUInt32BE(totalLength, 0);
    buffer.writeUInt16BE(labelLength, 4);
    labelBuffer.copy(buffer, 6);
    
    this._socket.write(buffer);
    console.log(`[NativePeerConnection] Announced channel: ${label}`);
  }

  /**
   * Handle incoming data from socket
   * @private
   */
  _handleIncomingData(data) {
    try {
      // Parse message format: <length:4><channel-label-length:2><channel-label><data>
      let offset = 0;
      
      while (offset < data.length) {
        if (offset + 6 > data.length) break;
        
        const totalLength = data.readUInt32BE(offset);
        const labelLength = data.readUInt16BE(offset + 4);
        
        if (offset + 6 + labelLength + (totalLength - 2 - labelLength) > data.length) break;
        
        const label = data.toString('utf8', offset + 6, offset + 6 + labelLength);
        const messageData = data.slice(offset + 6 + labelLength, offset + 6 + totalLength - 2);
        
        // Find or create the data channel
        let channel = this._dataChannels.get(label);
        if (!channel) {
          // Create remote data channel
          console.log(`[NativePeerConnection] Creating remote channel: ${label}`);
          channel = new NativeDataChannel(label, {}, this);
          this._dataChannels.set(label, channel);
          
          // Emit datachannel event first (before setting connected)
          this.emit('datachannel', channel);
          
          // Then set it as connected after a small delay to allow event handlers to be set up
          setImmediate(() => {
            channel._setConnected(this._socket);
          });
        }
        
        // Deliver the message (if it has data - announcements are empty)
        if (messageData.length > 0) {
          channel._handleIncomingMessage(messageData);
        }
        
        offset += 6 + totalLength - 2;
      }
    } catch (err) {
      console.error('[NativePeerConnection] Error parsing incoming data:', err);
    }
  }

  /**
   * Generate real SDP with actual network information
   * @private
   */
  _generateSDP(type) {
    const sessionId = Date.now();
    const address = this._localAddress || '0.0.0.0';
    const port = this._localPort || 9;
    
    return `v=0
o=- ${sessionId} 2 IN IP4 ${address}
s=-
t=0 0
a=group:BUNDLE data
a=msid-semantic: WMS
m=application ${port} TCP/DTLS/SCTP webrtc-datachannel
c=IN IP4 ${address}
a=ice-ufrag:${this._iceUsername}
a=ice-pwd:${this._icePassword}
a=ice-options:trickle
a=fingerprint:sha-256 ${this._fingerprint}
a=setup:actpass
a=mid:data
a=sctp-port:5000
a=max-message-size:262144
`;
  }

  /**
   * Parse SDP to extract connection information
   * @private
   */
  _parseSDP(sdp) {
    const lines = sdp.split('\n');
    
    for (const line of lines) {
      // Parse connection line: c=IN IP4 <address>
      if (line.startsWith('c=IN IP4 ')) {
        const address = line.substring(9).trim();
        if (address !== '0.0.0.0') {
          this._remoteAddress = address;
        }
      }
      
      // Parse media line: m=application <port> ...
      if (line.startsWith('m=application ')) {
        const parts = line.split(' ');
        if (parts.length >= 2) {
          const port = parseInt(parts[1], 10);
          if (port > 0 && port !== 9) {
            this._remotePort = port;
          }
        }
      }
    }
    
    console.log(`[NativePeerConnection] Parsed SDP - Remote: ${this._remoteAddress}:${this._remotePort}`);
  }

  /**
   * Get local IP address
   * @private
   */
  _getLocalIPAddress() {
    const interfaces = os.networkInterfaces();
    
    // Try to find a non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    
    // Fallback to localhost
    return '127.0.0.1';
  }

  /**
   * Start ICE gathering with real network addresses
   * @private
   */
  _startIceGathering() {
    this._iceGatheringState = 1; // gathering
    this.emit('icegatheringstatechange', this._iceGatheringState);

    // Generate real ICE candidate with local address
    setTimeout(() => {
      if (this._localAddress && this._localPort) {
        const candidate = {
          candidate: `candidate:1 1 tcp 2130706431 ${this._localAddress} ${this._localPort} typ host`,
          sdpMid: 'data',
          sdpMLineIndex: 0
        };
        this.emit('icecandidate', candidate);
        
        console.log(`[NativePeerConnection] Generated ICE candidate: ${this._localAddress}:${this._localPort}`);
      }

      // Complete gathering
      setTimeout(() => {
        this._iceGatheringState = 2; // complete
        this.emit('icegatheringstatechange', this._iceGatheringState);
        this.emit('icecandidate', null); // End of candidates
      }, 100);
    }, 50);
  }

  /**
   * Generate random string
   * @private
   */
  _generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Generate fingerprint
   * @private
   */
  _generateFingerprint() {
    const bytes = [];
    for (let i = 0; i < 32; i++) {
      bytes.push(Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase());
    }
    return bytes.join(':');
  }
}

/**
 * NativeDataChannel - Real implementation using TCP socket
 */
class NativeDataChannel extends EventEmitter {
  constructor(label, options = {}, peerConnection) {
    super();
    this.label = label;
    this.ordered = options.ordered !== undefined ? options.ordered : true;
    this.maxPacketLifeTime = options.maxPacketLifeTime || -1;
    this.maxRetransmits = options.maxRetransmits || -1;
    this.protocol = options.protocol || '';
    this.negotiated = options.negotiated || false;
    this.id = options.id !== undefined ? options.id : -1;
    
    this._state = 0; // connecting
    this._bufferedAmount = 0;
    this._closed = false;
    this._socket = null;
    this._peerConnection = peerConnection;

    console.log(`[NativeDataChannel] Created: ${label}`);
  }

  /**
   * Set socket connection for this channel
   * @private
   */
  _setConnected(socket) {
    if (this._closed) {
      return;
    }

    this._socket = socket;
    this._state = 1; // open
    this.emit('statechange', this._state);
    console.log(`[NativeDataChannel] ${this.label} - Channel opened`);
  }

  /**
   * Handle incoming message for this channel
   * @private
   */
  _handleIncomingMessage(data) {
    if (this._state !== 1) {
      return;
    }

    // Check if data is binary or text
    let binary = true;
    try {
      // Try to detect if it's valid UTF-8 text
      const text = data.toString('utf8');
      if (text.length > 0 && /^[\x20-\x7E\s]*$/.test(text)) {
        binary = false;
      }
    } catch (e) {
      binary = true;
    }

    this.emit('message', { data, binary });
  }

  /**
   * Handle socket disconnect
   * @private
   */
  _handleDisconnect() {
    if (this._closed) {
      return;
    }

    this._socket = null;
    this._state = 3; // closed
    this.emit('statechange', this._state);
  }

  /**
   * Send data over the channel
   * @param {Object} dataBuffer - { data: Buffer, binary: boolean }
   */
  send(dataBuffer) {
    if (this._state !== 1) {
      throw new Error('DataChannel is not open');
    }

    if (!this._socket || !this._socket.writable) {
      throw new Error('Socket is not writable');
    }

    try {
      const data = dataBuffer.data;
      const labelBuffer = Buffer.from(this.label, 'utf8');
      
      // Message format: <length:4><label-length:2><label><data>
      // Length includes label-length field + label + data
      const totalLength = 2 + labelBuffer.length + data.length;
      const header = Buffer.allocUnsafe(6);
      header.writeUInt32BE(totalLength, 0);
      header.writeUInt16BE(labelBuffer.length, 4);
      
      const message = Buffer.concat([header, labelBuffer, data]);
      
      this._bufferedAmount += message.length;
      this._socket.write(message, () => {
        this._bufferedAmount = Math.max(0, this._bufferedAmount - message.length);
        if (this._bufferedAmount === 0) {
          this.emit('bufferedamountlow', 0);
        }
      });
      
      console.log(`[NativeDataChannel] ${this.label} - Sent ${data.length} bytes`);
    } catch (err) {
      console.error(`[NativeDataChannel] ${this.label} - Send error:`, err);
      throw err;
    }
  }

  /**
   * Close the channel
   */
  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._state = 2; // closing
    this.emit('statechange', this._state);

    setTimeout(() => {
      this._state = 3; // closed
      this._socket = null;
      this.emit('statechange', this._state);
    }, 10);
  }
}

module.exports = NativePeerConnectionFactory;
