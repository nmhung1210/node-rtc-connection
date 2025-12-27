/**
 * @file RTCIceTransport.js
 * @description ICE transport implementation for establishing connectivity.
 * @module ice/RTCIceTransport
 * 
 * Ported from Chromium's RTCIceTransport implementation:
 * - cc/rtc_ice_transport.h
 * - cc/rtc_ice_transport.cc
 * - cc/rtc_ice_transport.idl
 */

const EventEmitter = require('events');
const STUNClient = require('../stun/stun-client');
const dgram = require('dgram');
const crypto = require('crypto');

/**
 * RTCIceRole - The role in the ICE process
 * @readonly
 * @enum {string}
 */
const RTCIceRole = Object.freeze({
  CONTROLLING: 'controlling',
  CONTROLLED: 'controlled'
});

/**
 * RTCIceTransportState - Current state of the ICE transport
 * @readonly
 * @enum {string}
 */
const RTCIceTransportState = Object.freeze({
  NEW: 'new',
  CHECKING: 'checking',
  CONNECTED: 'connected',
  COMPLETED: 'completed',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed'
});

/**
 * RTCIceGatheringState - ICE candidate gathering state
 * @readonly
 * @enum {string}
 */
const RTCIceGatheringState = Object.freeze({
  NEW: 'new',
  GATHERING: 'gathering',
  COMPLETE: 'complete'
});

/**
 * RTCIceParameters - ICE username fragment and password
 * @typedef {Object} RTCIceParameters
 * @property {string} usernameFragment - ICE username fragment
 * @property {string} password - ICE password
 */

/**
 * RTCIceCandidatePair - A pair of local and remote ICE candidates
 * @typedef {Object} RTCIceCandidatePair
 * @property {RTCIceCandidate} local - The local candidate
 * @property {RTCIceCandidate} remote - The remote candidate
 */

/**
 * RTCIceGatherOptions - Options for ICE candidate gathering
 * @typedef {Object} RTCIceGatherOptions
 * @property {RTCIceGatherPolicy} [gatherPolicy='all'] - Candidate gathering policy
 * @property {Array<RTCIceServer>} [iceServers] - STUN/TURN servers to use
 */

/**
 * @class RTCIceTransport
 * @extends EventEmitter
 * @description Represents the ICE transport layer for a peer connection.
 * Manages ICE candidate gathering, connectivity checks, and state transitions.
 * 
 * Events:
 * - 'statechange': Fired when the transport state changes
 * - 'gatheringstatechange': Fired when the gathering state changes
 * - 'selectedcandidatepairchange': Fired when the selected candidate pair changes
 * - 'icecandidate': Fired when a new local candidate is gathered
 * 
 * @example
 * const transport = new RTCIceTransport();
 * transport.on('statechange', () => {
 *   console.log('State:', transport.state);
 * });
 * transport.on('icecandidate', (candidate) => {
 *   // Send candidate to remote peer
 * });
 */
class RTCIceTransport extends EventEmitter {
  /**
   * Create an RTCIceTransport instance.
   */
  constructor() {
    super();

    // Internal state
    this._role = null; // RTCIceRole or null
    this._state = RTCIceTransportState.NEW;
    this._gatheringState = RTCIceGatheringState.NEW;
    
    // Candidate lists
    this._localCandidates = [];
    this._remoteCandidates = [];
    
    // ICE parameters
    this._localParameters = null;
    this._remoteParameters = null;
    
    // Selected candidate pair
    this._selectedCandidatePair = null;
    
    // Started flag
    this._started = false;
    
    // Closed flag
    this._closed = false;
    
    // ICE servers (STUN/TURN)
    this._iceServers = [];
    
    // STUN clients
    this._stunClients = [];
    
    // UDP sockets for candidates
    this._sockets = new Map(); // Map of candidate foundation -> socket
    
    // Candidate pairs and connectivity checks
    this._candidatePairs = [];
    this._validPairs = [];
  }

  /**
   * Get the ICE role (controlling or controlled).
   * @returns {string|null} The ICE role or null if not started
   */
  get role() {
    return this._role;
  }

  /**
   * Get the current ICE transport state.
   * @returns {string} The transport state
   */
  get state() {
    return this._state;
  }

  /**
   * Get the current ICE gathering state.
   * @returns {string} The gathering state
   */
  get gatheringState() {
    return this._gatheringState;
  }

  /**
   * Get the local ICE candidates.
   * @returns {Array<RTCIceCandidate>} Array of local candidates
   */
  getLocalCandidates() {
    return [...this._localCandidates];
  }

  /**
   * Get the remote ICE candidates.
   * @returns {Array<RTCIceCandidate>} Array of remote candidates
   */
  getRemoteCandidates() {
    return [...this._remoteCandidates];
  }

  /**
   * Get the selected candidate pair.
   * @returns {RTCIceCandidatePair|null} The selected candidate pair or null
   */
  getSelectedCandidatePair() {
    return this._selectedCandidatePair ? { ...this._selectedCandidatePair } : null;
  }

  /**
   * Get the local ICE parameters.
   * @returns {RTCIceParameters|null} The local parameters or null
   */
  getLocalParameters() {
    return this._localParameters ? { ...this._localParameters } : null;
  }

  /**
   * Get the remote ICE parameters.
   * @returns {RTCIceParameters|null} The remote parameters or null
   */
  getRemoteParameters() {
    return this._remoteParameters ? { ...this._remoteParameters } : null;
  }

  /**
   * Generate random local ICE parameters.
   * Creates a random username fragment and password.
   * @private
   */
  _generateLocalParameters() {
    const crypto = require('crypto');
    
    // Generate random username fragment (16 characters)
    const usernameFragment = crypto.randomBytes(8).toString('hex');
    
    // Generate random password (22 characters, base64)
    const password = crypto.randomBytes(16).toString('base64').substring(0, 22);
    
    this._localParameters = {
      usernameFragment,
      password
    };
  }

  /**
   * Start the ICE transport with remote parameters and role.
   * @param {RTCIceParameters} remoteParameters - The remote ICE parameters
   * @param {string} role - The ICE role ('controlling' or 'controlled')
   * @throws {Error} If transport is closed or already started
   * @throws {TypeError} If parameters are invalid
   */
  start(remoteParameters, role) {
    if (this._closed) {
      throw new Error('RTCIceTransport is closed');
    }

    if (this._started) {
      throw new Error('RTCIceTransport already started');
    }

    // Validate role
    if (role !== RTCIceRole.CONTROLLING && role !== RTCIceRole.CONTROLLED) {
      throw new TypeError(`Invalid role: ${role}`);
    }

    // Validate remote parameters
    if (!remoteParameters || typeof remoteParameters !== 'object') {
      throw new TypeError('Remote parameters must be an object');
    }

    if (typeof remoteParameters.usernameFragment !== 'string' || 
        remoteParameters.usernameFragment.length === 0) {
      throw new TypeError('usernameFragment must be a non-empty string');
    }

    if (typeof remoteParameters.password !== 'string' || 
        remoteParameters.password.length === 0) {
      throw new TypeError('password must be a non-empty string');
    }

    // Generate local parameters if not already done
    if (!this._localParameters) {
      this._generateLocalParameters();
    }

    // Store remote parameters and role
    this._remoteParameters = {
      usernameFragment: remoteParameters.usernameFragment,
      password: remoteParameters.password
    };
    this._role = role;
    this._started = true;

    // Transition to checking state
    this._setState(RTCIceTransportState.CHECKING);
    
    // Start connectivity checks if we have candidates
    if (this._remoteCandidates.length > 0 && this._localCandidates.length > 0) {
      this._startConnectivityChecks();
    }
  }

  /**
   * Start gathering ICE candidates.
   * @param {RTCIceGatherOptions} [options] - Gathering options
   * @throws {Error} If transport is closed
   */
  async gather(options = {}) {
    if (this._closed) {
      throw new Error('RTCIceTransport is closed');
    }

    // Generate local parameters if not already done
    if (!this._localParameters) {
      this._generateLocalParameters();
    }

    // Store ICE servers
    if (options.iceServers) {
      this._iceServers = options.iceServers;
    }

    // Transition to gathering state
    this._setGatheringState(RTCIceGatheringState.GATHERING);

    // Gather host candidates (local addresses)
    await this._gatherHostCandidates();

    // Gather server reflexive candidates (STUN)
    await this._gatherServerReflexiveCandidates();

    // Gather relay candidates (TURN)
    await this._gatherRelayCandidates();

    // Complete gathering
    setImmediate(() => {
      if (!this._closed) {
        this._setGatheringState(RTCIceGatheringState.COMPLETE);
      }
    });
  }

  /**
   * Add a remote ICE candidate.
   * @param {RTCIceCandidate} candidate - The remote candidate to add
   * @throws {Error} If transport is closed or not started
   * @throws {TypeError} If candidate is invalid
   */
  addRemoteCandidate(candidate) {
    if (this._closed) {
      throw new Error('RTCIceTransport is closed');
    }

    if (!this._started) {
      throw new Error('RTCIceTransport not started');
    }

    if (!candidate || typeof candidate !== 'object') {
      throw new TypeError('Candidate must be an object');
    }

    // Add to remote candidates list
    this._remoteCandidates.push(candidate);

    // Start connectivity checks if we're in checking state
    if (this._state === RTCIceTransportState.CHECKING && this._localCandidates.length > 0) {
      // Create pairs for this new remote candidate with all local candidates
      for (const localCandidate of this._localCandidates) {
        const pair = {
          local: localCandidate,
          remote: candidate,
          state: 'waiting'
        };
        this._candidatePairs.push(pair);
        this._sendConnectivityCheck(pair);
      }
    }
  }

  /**
   * Stop the ICE transport.
   * Transitions to closed state and stops all ICE processing.
   */
  stop() {
    if (this._closed) {
      return;
    }

    this._close('stopped');
  }

  /**
   * Internal close method.
   * @param {string} reason - Reason for closing
   * @private
   */
  _close(reason) {
    if (this._closed) {
      return;
    }

    this._closed = true;
    this._setState(RTCIceTransportState.CLOSED);
    
    // Close all UDP sockets
    this._closeSockets();
    
    // Clean up STUN/TURN clients
    if (this._stunClients) {
      for (const client of this._stunClients) {
        client.close();
      }
      this._stunClients = [];
    }

    // Clear refresh timers
    if (this._refreshTimers) {
      for (const timer of this._refreshTimers) {
        clearInterval(timer);
      }
      this._refreshTimers = [];
    }

    // Clean up
    this._localCandidates = [];
    this._remoteCandidates = [];
    this._selectedCandidatePair = null;
  }

  /**
   * Set the transport state and emit event if changed.
   * @param {string} newState - The new state
   * @private
   */
  _setState(newState) {
    if (this._state !== newState) {
      this._state = newState;
      this.emit('statechange');
    }
  }

  /**
   * Set the gathering state and emit event if changed.
   * @param {string} newState - The new gathering state
   * @private
   */
  _setGatheringState(newState) {
    if (this._gatheringState !== newState) {
      this._gatheringState = newState;
      this.emit('gatheringstatechange');
    }
  }

  /**
   * Add a local candidate (called internally during gathering).
   * @param {RTCIceCandidate} candidate - The local candidate
   * @private
   */
  _addLocalCandidate(candidate) {
    this._localCandidates.push(candidate);
    this.emit('icecandidate', candidate);
  }

  /**
   * Set the selected candidate pair.
   * @param {RTCIceCandidatePair} pair - The selected pair
   * @private
   */
  _setSelectedCandidatePair(pair) {
    this._selectedCandidatePair = pair;
    this.emit('selectedcandidatepairchange');
  }

  /**
   * Check if the transport is in a terminal state.
   * @returns {boolean} True if closed, false otherwise
   */
  isClosed() {
    return this._state === RTCIceTransportState.CLOSED;
  }

  /**
   * Gather host candidates (local network interfaces)
   * @private
   */
  async _gatherHostCandidates() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        // Skip internal and IPv6 for now
        if (addr.internal || addr.family !== 'IPv4') {
          continue;
        }

        // Create UDP socket for this candidate
        const socket = dgram.createSocket('udp4');
        
        await new Promise((resolve, reject) => {
          socket.on('error', reject);
          
          // Bind to the interface address with port 0 (auto-assign)
          socket.bind(0, addr.address, () => {
            const address = socket.address();
            
            const RTCIceCandidate = require('./RTCIceCandidate');
            const foundation = crypto.randomBytes(4).toString('hex');
            
            // Generate SDP candidate string
            const candidateString = `candidate:${foundation} 1 udp ${2130706431} ${address.address} ${address.port} typ host`;
            
            const candidate = new RTCIceCandidate({
              candidate: candidateString,
              sdpMid: '0',
              sdpMLineIndex: 0,
              foundation,
              priority: 2130706431, // Host candidates have highest priority
              address: address.address,
              protocol: 'udp',
              port: address.port,
              type: 'host',
              component: 'rtp',
              usernameFragment: this._localParameters.usernameFragment
            });

            // Store socket associated with this candidate
            this._sockets.set(foundation, socket);
            
            // Setup socket message handler for ICE connectivity checks
            socket.on('message', (msg, rinfo) => {
              this._handleSocketMessage(msg, rinfo, candidate);
            });
            
            socket.on('error', (err) => {
              console.error(`Socket error for ${address.address}:${address.port}:`, err);
            });

            this._addLocalCandidate(candidate);
            resolve();
          });
        });
      }
    }
  }

  /**
   * Gather server reflexive candidates using STUN
   * @private
   */
  async _gatherServerReflexiveCandidates() {
    if (!this._iceServers || this._iceServers.length === 0) {
      return;
    }

    // Use the first host candidate's socket for STUN queries
    const hostCandidates = this._localCandidates.filter(c => c.type === 'host');
    if (hostCandidates.length === 0) {
      return; // No host candidates to use
    }

    for (const server of this._iceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

      for (const url of urls) {
        if (!url.startsWith('stun:')) {
          continue; // Skip non-STUN servers
        }

        try {
          const parsed = this._parseServerUrl(url);
          const stunClient = new STUNClient({
            server: parsed.host,
            port: parsed.port,
            username: server.username,
            credential: server.credential
          });

          this._stunClients.push(stunClient);

          const reflexiveAddr = await stunClient.getReflexiveAddress();

          const RTCIceCandidate = require('./RTCIceCandidate');
          const foundation = crypto.randomBytes(4).toString('hex');
          const hostCandidate = hostCandidates[0];
          
          // Generate SDP candidate string for server reflexive candidate
          const candidateString = `candidate:${foundation} 1 udp ${1694498815} ${reflexiveAddr.address} ${reflexiveAddr.port} typ srflx raddr ${hostCandidate.address} rport ${hostCandidate.port}`;
          
          const candidate = new RTCIceCandidate({
            candidate: candidateString,
            sdpMid: '0',
            sdpMLineIndex: 0,
            foundation,
            priority: 1694498815, // Server reflexive candidates
            address: reflexiveAddr.address,
            protocol: 'udp',
            port: reflexiveAddr.port,
            type: 'srflx',
            component: 'rtp',
            relatedAddress: hostCandidate.address,
            relatedPort: hostCandidate.port,
            usernameFragment: this._localParameters.usernameFragment
          });

          // Store the socket (same as host candidate's socket)
          this._sockets.set(foundation, this._sockets.get(hostCandidate.foundation));

          this._addLocalCandidate(candidate);
        } catch (error) {
          console.error(`Failed to gather from STUN server ${url}:`, error.message);
        }
      }
    }
  }

  /**
   * Gather relay candidates using TURN
   * @private
   */
  async _gatherRelayCandidates() {
    if (!this._iceServers || this._iceServers.length === 0) {
      return;
    }

    for (const server of this._iceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

      for (const url of urls) {
        if (!url.startsWith('turn:') && !url.startsWith('turns:')) {
          continue; // Skip non-TURN servers
        }

        // TURN requires authentication
        if (!server.username || !server.credential) {
          console.warn(`TURN server ${url} requires username and credential`);
          continue;
        }

        try {
          const parsed = this._parseServerUrl(url);
          const turnClient = new STUNClient({
            server: parsed.host,
            port: parsed.port,
            username: server.username,
            credential: server.credential,
            transport: parsed.transport || 'udp'
          });

          this._stunClients.push(turnClient);

          // Allocate relay address
          const allocation = await turnClient.allocateRelay(600);

          const RTCIceCandidate = require('./RTCIceCandidate');
          const foundation = crypto.randomBytes(4).toString('hex');
          
          // Generate SDP candidate string for relay candidate
          const candidateString = `candidate:${foundation} 1 udp ${16777215} ${allocation.relayedAddress} ${allocation.relayedPort} typ relay raddr ${parsed.host} rport ${parsed.port}`;
          
          const candidate = new RTCIceCandidate({
            candidate: candidateString,
            sdpMid: '0',
            sdpMLineIndex: 0,
            foundation,
            priority: 16777215, // Relay candidates have lowest priority
            address: allocation.relayedAddress,
            protocol: 'udp',
            port: allocation.relayedPort,
            type: 'relay',
            component: 'rtp',
            relatedAddress: parsed.host, // TURN server address
            relatedPort: parsed.port,
            usernameFragment: this._localParameters.usernameFragment
          });

          // Store TURN client as the "socket" for this relay candidate
          this._sockets.set(foundation, { type: 'turn', client: turnClient });

          this._addLocalCandidate(candidate);

          // Keep allocation alive
          this._keepAllocAlive(turnClient, allocation.lifetime);
        } catch (error) {
          console.error(`Failed to allocate from TURN server ${url}:`, error.message);
        }
      }
    }
  }

  /**
   * Keep TURN allocation alive by sending periodic refresh requests
   * @param {STUNClient} client - TURN client
   * @param {number} lifetime - Allocation lifetime
   * @private
   */
  _keepAllocAlive(client, lifetime) {
    // Refresh 30 seconds before expiry
    const refreshInterval = (lifetime - 30) * 1000;
    
    const refreshTimer = setInterval(async () => {
      if (this._closed) {
        clearInterval(refreshTimer);
        return;
      }

      try {
        await client.refreshAllocation(600);
      } catch (error) {
        console.error('Failed to refresh TURN allocation:', error.message);
        clearInterval(refreshTimer);
      }
    }, refreshInterval);

    // Store timer for cleanup
    if (!this._refreshTimers) {
      this._refreshTimers = [];
    }
    this._refreshTimers.push(refreshTimer);
  }

  /**
   * Start ICE connectivity checks
   * @private
   */
  _startConnectivityChecks() {
    // Form candidate pairs (simplified: just pair first local with first remote)
    for (const localCandidate of this._localCandidates) {
      for (const remoteCandidate of this._remoteCandidates) {
        this._candidatePairs.push({
          local: localCandidate,
          remote: remoteCandidate,
          state: 'waiting'
        });
      }
    }

    // Send connectivity checks for each pair
    for (const pair of this._candidatePairs) {
      this._sendConnectivityCheck(pair);
    }
  }

  /**
   * Send a connectivity check (STUN Binding Request) to a candidate pair
   * @param {Object} pair - Candidate pair
   * @private
   */
  _sendConnectivityCheck(pair) {
    const socket = this._sockets.get(pair.local.foundation);
    if (!socket || socket.type === 'turn') {
      return; // Skip TURN candidates for now
    }

    const transactionId = crypto.randomBytes(12);
    const request = this._createBindingRequest(transactionId);
    
    try {
      socket.send(request, pair.remote.port, pair.remote.address, (err) => {
        if (err) {
          console.error(`Connectivity check failed for ${pair.remote.address}:${pair.remote.port}:`, err);
        }
      });
    } catch (err) {
      console.error(`Error sending connectivity check:`, err);
    }
  }

  /**
   * Create a STUN Binding Request for connectivity checks
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Buffer} STUN Binding Request
   * @private
   */
  _createBindingRequest(transactionId) {
    const MAGIC_COOKIE = 0x2112A442;
    
    // Simple binding request with no attributes
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0001, 0); // Binding Request
    header.writeUInt16BE(0, 2); // Message length (no attributes for now)
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    
    return header;
  }

  /**
   * Parse STUN/TURN server URL
   * @param {string} url - Server URL
   * @returns {Object} Parsed URL
   * @private
   */
  _parseServerUrl(url) {
    // Match: (stun|turn|turns)://host:port?transport=udp
    // Or: (stun|turn|turns):host:port?transport=tcp
    const match = url.match(/^(stun|turn|turns):\/?\/?([^:?]+):?(\d+)?(\?transport=(\w+))?/);
    if (!match) {
      throw new Error(`Invalid server URL: ${url}`);
    }

    const protocol = match[1];
    const host = match[2];
    const port = match[3];
    const transport = match[5] || 'udp'; // Default to UDP

    return {
      protocol,
      host,
      port: parseInt(port || (protocol === 'turns' ? '5349' : '3478'), 10),
      transport
    };
  }

  /**
   * Handle incoming messages on a socket (ICE connectivity checks)
   * @param {Buffer} msg - The message buffer
   * @param {Object} rinfo - Remote address info
   * @param {RTCIceCandidate} localCandidate - The local candidate that received the message
   * @private
   */
  _handleSocketMessage(msg, rinfo, localCandidate) {
    // Check if this is a STUN message (magic cookie check)
    if (msg.length < 20) return;
    
    const magicCookie = msg.readUInt32BE(4);
    if (magicCookie !== 0x2112A442) return; // Not a STUN message
    
    const messageType = msg.readUInt16BE(0);
    
    // STUN Binding Request (0x0001) - this is an ICE connectivity check
    if (messageType === 0x0001) {
      this._handleBindingRequest(msg, rinfo, localCandidate);
    }
    // STUN Binding Response (0x0101) - response to our connectivity check
    else if (messageType === 0x0101) {
      this._handleBindingResponse(msg, rinfo, localCandidate);
    }
  }

  /**
   * Handle STUN Binding Request (incoming connectivity check)
   * @param {Buffer} msg - The STUN message
   * @param {Object} rinfo - Remote address info
   * @param {RTCIceCandidate} localCandidate - The local candidate
   * @private
   */
  _handleBindingRequest(msg, rinfo, localCandidate) {
    // Send Binding Response
    const transactionId = msg.slice(8, 20);
    const response = this._createBindingResponse(transactionId, rinfo.address, rinfo.port);
    
    const socket = this._sockets.get(localCandidate.foundation);
    if (socket) {
      socket.send(response, rinfo.port, rinfo.address);
      
      // If we haven't selected a candidate pair yet and this check succeeded,
      // this could be our selected pair
      if (!this._selectedCandidatePair && this._state === RTCIceTransportState.CHECKING) {
        this._setState(RTCIceTransportState.CONNECTED);
      }
    }
  }

  /**
   * Handle STUN Binding Response (response to our connectivity check)
   * @param {Buffer} msg - The STUN message
   * @param {Object} rinfo - Remote address info
   * @param {RTCIceCandidate} localCandidate - The local candidate
   * @private
   */
  _handleBindingResponse(msg, rinfo, localCandidate) {
    // Mark this candidate pair as valid
    // In a full implementation, we would track which pair this belongs to
    if (!this._selectedCandidatePair && this._state === RTCIceTransportState.CHECKING) {
      this._setState(RTCIceTransportState.CONNECTED);
    }
  }

  /**
   * Create a STUN Binding Response
   * @param {Buffer} transactionId - Transaction ID from the request
   * @param {string} address - XOR-mapped address
   * @param {number} port - XOR-mapped port
   * @returns {Buffer} STUN Binding Response message
   * @private
   */
  _createBindingResponse(transactionId, address, port) {
    const MAGIC_COOKIE = 0x2112A442;
    
    // XOR the port with magic cookie high 16 bits
    const xorPort = port ^ (MAGIC_COOKIE >> 16);
    
    // XOR the address with magic cookie
    const addrParts = address.split('.').map(Number);
    const addrNum = (addrParts[0] << 24) | (addrParts[1] << 16) | (addrParts[2] << 8) | addrParts[3];
    const xorAddr = addrNum ^ MAGIC_COOKIE;
    
    // Build XOR-MAPPED-ADDRESS attribute
    const attr = Buffer.alloc(12);
    attr.writeUInt16BE(0x0020, 0); // XOR-MAPPED-ADDRESS
    attr.writeUInt16BE(8, 2); // Length
    attr.writeUInt8(0, 4); // Reserved
    attr.writeUInt8(0x01, 5); // Family (IPv4)
    attr.writeUInt16BE(xorPort, 6);
    attr.writeUInt32BE(xorAddr, 8);
    
    // Build message
    const header = Buffer.alloc(20);
    header.writeUInt16BE(0x0101, 0); // Binding Response
    header.writeUInt16BE(12, 2); // Message length (attribute size)
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);
    
    return Buffer.concat([header, attr]);
  }

  /**
   * Check if start() has been called.
   * @returns {boolean} True if started, false otherwise
   */
  isStarted() {
    return this._started;
  }
  
  /**
   * Get a socket for data transmission (returns the first available socket)
   * @returns {Object|null} UDP socket or null
   */
  getSocket() {
    const sockets = Array.from(this._sockets.values());
    return sockets.length > 0 ? sockets[0] : null;
  }
  
  /**
   * Close all sockets
   * @private
   */
  _closeSockets() {
    for (const socket of this._sockets.values()) {
      try {
        socket.close();
      } catch (err) {
        // Ignore errors when closing
      }
    }
    this._sockets.clear();
  }
}

// Export the class and enums
module.exports = {
  RTCIceTransport,
  RTCIceRole,
  RTCIceTransportState,
  RTCIceGatheringState
};
