/**
 * RTCIceCandidate represents an ICE candidate.
 * Ported from Chromium's implementation.
 */
class RTCIceCandidate {
  constructor(candidateInitDict = {}) {
    this._candidate = candidateInitDict.candidate || '';
    this._sdpMid = candidateInitDict.sdpMid || null;
    this._sdpMLineIndex = candidateInitDict.sdpMLineIndex !== undefined 
      ? candidateInitDict.sdpMLineIndex 
      : null;
    this._usernameFragment = candidateInitDict.usernameFragment || null;
    
    // Parse candidate string if provided
    if (this._candidate) {
      this._parseCandidateString();
    }
  }

  /**
   * The candidate string
   */
  get candidate() {
    return this._candidate;
  }

  /**
   * The media stream identification tag
   */
  get sdpMid() {
    return this._sdpMid;
  }

  /**
   * The media line index
   */
  get sdpMLineIndex() {
    return this._sdpMLineIndex;
  }

  /**
   * The username fragment
   */
  get usernameFragment() {
    return this._usernameFragment;
  }

  /**
   * The foundation
   */
  get foundation() {
    return this._foundation || null;
  }

  /**
   * The component (RTP or RTCP)
   */
  get component() {
    return this._component || null;
  }

  /**
   * The priority
   */
  get priority() {
    return this._priority || null;
  }

  /**
   * The IP address
   */
  get address() {
    return this._address || null;
  }

  /**
   * The protocol (udp or tcp)
   */
  get protocol() {
    return this._protocol || null;
  }

  /**
   * The port
   */
  get port() {
    return this._port || null;
  }

  /**
   * The candidate type (host, srflx, prflx, or relay)
   */
  get type() {
    return this._type || null;
  }

  /**
   * The TCP type (active, passive, or so)
   */
  get tcpType() {
    return this._tcpType || null;
  }

  /**
   * The related address (for non-host candidates)
   */
  get relatedAddress() {
    return this._relatedAddress || null;
  }

  /**
   * The related port (for non-host candidates)
   */
  get relatedPort() {
    return this._relatedPort || null;
  }

  /**
   * Parse the candidate string to extract individual fields
   * @private
   */
  _parseCandidateString() {
    if (!this._candidate || !this._candidate.startsWith('candidate:')) {
      return;
    }

    // Basic parsing of candidate string
    // Format: candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
    const parts = this._candidate.split(' ');
    
    if (parts.length >= 8) {
      this._foundation = parts[0].replace('candidate:', '');
      this._component = parts[1];
      this._protocol = parts[2];
      this._priority = parseInt(parts[3], 10);
      this._address = parts[4];
      this._port = parseInt(parts[5], 10);
      // parts[6] is 'typ'
      this._type = parts[7];
      
      // Parse optional fields
      for (let i = 8; i < parts.length; i += 2) {
        const key = parts[i];
        const value = parts[i + 1];
        
        switch (key) {
          case 'raddr':
            this._relatedAddress = value;
            break;
          case 'rport':
            this._relatedPort = parseInt(value, 10);
            break;
          case 'tcptype':
            this._tcpType = value;
            break;
          case 'ufrag':
            this._usernameFragment = value;
            break;
        }
      }
    }
  }

  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      candidate: this._candidate,
      sdpMid: this._sdpMid,
      sdpMLineIndex: this._sdpMLineIndex,
      usernameFragment: this._usernameFragment
    };
  }

  /**
   * Convert to string
   */
  toString() {
    return `RTCIceCandidate { candidate: "${this._candidate}", sdpMid: "${this._sdpMid}", sdpMLineIndex: ${this._sdpMLineIndex} }`;
  }
}

module.exports = RTCIceCandidate;
