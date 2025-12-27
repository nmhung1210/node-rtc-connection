/**
 * ICE Candidate Gatherer
 * Discovers local, reflexive (STUN), and relay (TURN) candidates
 */

const os = require('os');
const dgram = require('dgram');
const STUNClient = require('./STUNClient');
const TURNClient = require('./TURNClient');

class ICEGatherer {
  constructor(options = {}) {
    this.stunServers = options.stunServers || [
      'stun.l.google.com:19302',
      'stun1.l.google.com:19302',
      'stun2.l.google.com:19302'
    ];
    this.turnServers = options.turnServers || [];
    this.gatherTimeout = options.gatherTimeout || 5000;
  }

  /**
   * Gather all ICE candidates
   * @param {number} localPort - Local port being used
   * @returns {Promise<Array>} Array of ICE candidates
   */
  async gatherCandidates(localPort) {
    const candidates = [];

    // 1. Gather host candidates (local interfaces)
    const hostCandidates = this._getHostCandidates(localPort);
    candidates.push(...hostCandidates);

    // 2. Gather server reflexive candidates (via STUN)
    try {
      const srflxCandidates = await this._getServerReflexiveCandidates(localPort);
      candidates.push(...srflxCandidates);
    } catch (err) {
      console.warn('Failed to gather STUN candidates:', err.message);
    }

    // 3. Gather relay candidates (via TURN)
    try {
      const relayCandidates = await this._getRelayCandidates(localPort);
      candidates.push(...relayCandidates);
    } catch (err) {
      console.warn('Failed to gather TURN candidates:', err.message);
    }

    // 4. Sort by priority (host > srflx > relay)
    candidates.sort((a, b) => b.priority - a.priority);

    return candidates;
  }

  /**
   * Get host candidates from local network interfaces
   * @private
   */
  _getHostCandidates(port) {
    const candidates = [];
    const interfaces = os.networkInterfaces();
    let foundation = 1;

    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        // Skip internal and IPv6 for now
        if (addr.internal || addr.family !== 'IPv4') {
          continue;
        }

        const priority = this._calculatePriority('host', 65535, foundation);
        
        candidates.push({
          candidate: `candidate:${foundation} 1 udp ${priority} ${addr.address} ${port} typ host`,
          sdpMLineIndex: 0,
          sdpMid: 'data',
          foundation: String(foundation),
          component: 1,
          protocol: 'udp',
          priority,
          ip: addr.address,
          port,
          type: 'host',
          tcpType: null,
          relatedAddress: null,
          relatedPort: null
        });

        foundation++;
      }
    }

    return candidates;
  }

  /**
   * Get server reflexive candidates via STUN
   * @private
   */
  async _getServerReflexiveCandidates(localPort) {
    const candidates = [];
    const stunPromises = [];

    // Try multiple STUN servers in parallel
    for (const stunServer of this.stunServers) {
      const promise = this._querySTUNServer(stunServer, localPort)
        .catch(err => null); // Ignore individual failures
      stunPromises.push(promise);
    }

    // Wait for first successful response
    const results = await Promise.race([
      Promise.any(stunPromises.filter(p => p)),
      new Promise(resolve => setTimeout(() => resolve(null), this.gatherTimeout))
    ]);

    if (results) {
      const foundation = 100;
      const priority = this._calculatePriority('srflx', 65535, foundation);

      candidates.push({
        candidate: `candidate:${foundation} 1 udp ${priority} ${results.ip} ${results.port} typ srflx raddr ${results.localIp} rport ${localPort}`,
        sdpMLineIndex: 0,
        sdpMid: 'data',
        foundation: String(foundation),
        component: 1,
        protocol: 'udp',
        priority,
        ip: results.ip,
        port: results.port,
        type: 'srflx',
        tcpType: null,
        relatedAddress: results.localIp,
        relatedPort: localPort
      });
    }

    return candidates;
  }

  /**
   * Query a STUN server
   * @private
   */
  async _querySTUNServer(stunServer, localPort) {
    const client = new STUNClient();
    try {
      const result = await client.getReflexiveAddress(stunServer);
      
      // Get local IP that would be used to reach STUN server
      const localIp = this._getLocalIPForRemote();
      
      return {
        ...result,
        localIp
      };
    } finally {
      client.close();
    }
  }

  /**
   * Get local IP address that would be used for external connections
   * @private
   */
  _getLocalIPForRemote() {
    const interfaces = os.networkInterfaces();
    
    // Prefer non-internal IPv4 addresses
    for (const [name, addrs] of Object.entries(interfaces)) {
      for (const addr of addrs) {
        if (!addr.internal && addr.family === 'IPv4') {
          return addr.address;
        }
      }
    }
    
    return '0.0.0.0';
  }

  /**
   * Get relay candidates via TURN
   * @private
   */
  async _getRelayCandidates(localPort) {
    const candidates = [];
    
    if (this.turnServers.length === 0) {
      return candidates;
    }

    const turnPromises = [];

    // Try TURN servers
    for (const turnConfig of this.turnServers) {
      const promise = this._queryTURNServer(turnConfig, localPort)
        .catch(err => null); // Ignore individual failures
      turnPromises.push(promise);
    }

    // Wait for first successful response
    const results = await Promise.race([
      Promise.any(turnPromises.filter(p => p)),
      new Promise(resolve => setTimeout(() => resolve(null), this.gatherTimeout))
    ]);

    if (results) {
      const foundation = 200;
      const priority = this._calculatePriority('relay', 65535, foundation);

      const localIp = this._getLocalIPForRemote();

      candidates.push({
        candidate: `candidate:${foundation} 1 udp ${priority} ${results.relayedAddress} ${results.relayedPort} typ relay raddr ${localIp} rport ${localPort}`,
        sdpMLineIndex: 0,
        sdpMid: 'data',
        foundation: String(foundation),
        component: 1,
        protocol: 'udp',
        priority,
        ip: results.relayedAddress,
        port: results.relayedPort,
        type: 'relay',
        tcpType: null,
        relatedAddress: localIp,
        relatedPort: localPort
      });
    }

    return candidates;
  }

  /**
   * Query a TURN server
   * @private
   */
  async _queryTURNServer(turnConfig, localPort) {
    const client = new TURNClient({
      server: turnConfig.urls || turnConfig.url,
      username: turnConfig.username,
      password: turnConfig.credential,
      transport: 'udp'
    });

    try {
      const result = await client.allocate();
      return result;
    } finally {
      client.close();
    }
  }

  /**
   * Calculate ICE candidate priority (RFC 5245)
   * @private
   */
  _calculatePriority(type, localPref, foundation) {
    const typePreference = {
      'host': 126,
      'srflx': 100,
      'prflx': 110,
      'relay': 0
    };

    const typePref = typePreference[type] || 0;
    const componentId = 1; // RTP component

    // Priority = (2^24)*(type preference) + (2^8)*(local preference) + (256 - component ID)
    return (typePref << 24) + (localPref << 8) + (256 - componentId);
  }

  /**
   * Parse ICE candidate string
   * @param {string} candidateStr - ICE candidate string
   * @returns {Object} Parsed candidate object
   */
  static parseCandidate(candidateStr) {
    // Remove "candidate:" prefix if present
    const str = candidateStr.replace(/^candidate:/, '');
    const parts = str.split(' ');

    if (parts.length < 8) {
      throw new Error('Invalid candidate string');
    }

    const candidate = {
      foundation: parts[0],
      component: parseInt(parts[1], 10),
      protocol: parts[2].toLowerCase(),
      priority: parseInt(parts[3], 10),
      ip: parts[4],
      port: parseInt(parts[5], 10),
      type: parts[7]
    };

    // Parse optional fields (raddr, rport, etc.)
    for (let i = 8; i < parts.length; i += 2) {
      const key = parts[i];
      const value = parts[i + 1];
      
      if (key === 'raddr') {
        candidate.relatedAddress = value;
      } else if (key === 'rport') {
        candidate.relatedPort = parseInt(value, 10);
      } else if (key === 'tcptype') {
        candidate.tcpType = value;
      }
    }

    return candidate;
  }
}

module.exports = ICEGatherer;
