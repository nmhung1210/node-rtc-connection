/**
 * @fileoverview RTCIceCandidate - ICE candidate representation.
 * 
 * Ported from Chromium's WebRTC implementation:
 * chromium/src/third_party/blink/renderer/modules/peerconnection/rtc_ice_candidate.{h,cc}
 * 
 * Represents an ICE (Interactive Connectivity Establishment) candidate that
 * describes a potential way to establish a connection with a peer.
 * 
 * @license BSD-3-Clause
 * @author nmhung1210
 */

'use strict';

/**
 * RTCIceCandidate represents a potential method for establishing connectivity.
 * 
 * ICE candidates are described using SDP (Session Description Protocol) syntax.
 * Each candidate describes a single address/port combination and transport protocol.
 */
class RTCIceCandidate {
  /**
   * Creates a new RTCIceCandidate.
   * 
   * @param {RTCIceCandidateInit} [candidateInit={}] - Initialization dictionary
   * @param {string} [candidateInit.candidate=''] - SDP candidate string
   * @param {string|null} [candidateInit.sdpMid] - Media stream ID
   * @param {number|null} [candidateInit.sdpMLineIndex] - M-line index
   * @param {string} [candidateInit.usernameFragment] - ICE username fragment
   * @throws {TypeError} If both sdpMid and sdpMLineIndex are null
   */
  constructor(candidateInit = {}) {
    // Validate that at least one of sdpMid or sdpMLineIndex is present
    if (candidateInit.sdpMid === null && candidateInit.sdpMLineIndex === null) {
      throw new TypeError('sdpMid and sdpMLineIndex are both null');
    }

    /**
     * SDP candidate string.
     * @private {string}
     */
    this._candidate = candidateInit.candidate || '';

    /**
     * Media stream identification.
     * @private {string|null}
     */
    this._sdpMid = candidateInit.sdpMid !== undefined ? candidateInit.sdpMid : null;

    /**
     * Media line index (zero-based).
     * @private {number|null}
     */
    this._sdpMLineIndex = candidateInit.sdpMLineIndex !== undefined ? 
      candidateInit.sdpMLineIndex : null;

    /**
     * ICE username fragment.
     * @private {string|null}
     */
    this._usernameFragment = candidateInit.usernameFragment || null;

    // Parse candidate string for detailed attributes
    this._parsedAttributes = this._parseCandidate(this._candidate);
  }

  /**
   * Parses an ICE candidate string to extract attributes.
   * Format: "candidate:foundation component protocol priority address port typ type [raddr reladdr] [rport relport]"
   * 
   * @private
   * @param {string} candidateStr - Candidate string to parse
   * @returns {Object} Parsed attributes
   */
  _parseCandidate(candidateStr) {
    const attrs = {
      foundation: null,
      component: null,
      protocol: null,
      priority: null,
      address: null,
      port: null,
      type: null,
      tcpType: null,
      relatedAddress: null,
      relatedPort: null
    };

    if (!candidateStr || !candidateStr.startsWith('candidate:')) {
      return attrs;
    }

    // Remove "candidate:" prefix
    const parts = candidateStr.substring(10).trim().split(/\s+/);
    
    if (parts.length < 8) {
      return attrs;
    }

    // Parse fixed fields
    attrs.foundation = parts[0];
    attrs.component = parts[1];
    attrs.protocol = parts[2].toLowerCase();
    attrs.priority = parseInt(parts[3], 10);
    attrs.address = parts[4];
    attrs.port = parseInt(parts[5], 10);
    
    // parts[6] should be "typ"
    if (parts[6] === 'typ') {
      attrs.type = parts[7];
    }

    // Parse optional attributes
    for (let i = 8; i < parts.length; i += 2) {
      const key = parts[i];
      const value = parts[i + 1];
      
      if (key === 'raddr') {
        attrs.relatedAddress = value;
      } else if (key === 'rport') {
        attrs.relatedPort = parseInt(value, 10);
      } else if (key === 'tcptype') {
        attrs.tcpType = value;
      }
    }

    return attrs;
  }

  /**
   * SDP candidate attribute containing the candidate description.
   * @type {string}
   */
  get candidate() {
    return this._candidate;
  }

  /**
   * Media stream identification tag.
   * @type {string|null}
   */
  get sdpMid() {
    return this._sdpMid;
  }

  /**
   * Index of the m-line in the SDP this candidate is associated with.
   * @type {number|null}
   */
  get sdpMLineIndex() {
    return this._sdpMLineIndex;
  }

  /**
   * ICE username fragment.
   * @type {string|null}
   */
  get usernameFragment() {
    return this._usernameFragment;
  }

  /**
   * Unique identifier for this candidate.
   * @type {string|null}
   */
  get foundation() {
    return this._parsedAttributes.foundation;
  }

  /**
   * Component identifier (rtp=1, rtcp=2).
   * @type {string|null}
   */
  get component() {
    return this._parsedAttributes.component;
  }

  /**
   * Priority value for this candidate.
   * Higher priority candidates are preferred.
   * @type {number|null}
   */
  get priority() {
    return this._parsedAttributes.priority;
  }

  /**
   * IP address of this candidate.
   * @type {string|null}
   */
  get address() {
    return this._parsedAttributes.address;
  }

  /**
   * Transport protocol (udp/tcp).
   * @type {string|null}
   */
  get protocol() {
    return this._parsedAttributes.protocol;
  }

  /**
   * Port number.
   * @type {number|null}
   */
  get port() {
    return this._parsedAttributes.port;
  }

  /**
   * Type of candidate (host, srflx, prflx, relay).
   * @type {string|null}
   */
  get type() {
    return this._parsedAttributes.type;
  }

  /**
   * TCP candidate type (active, passive, so).
   * Only applicable for TCP candidates.
   * @type {string|null}
   */
  get tcpType() {
    return this._parsedAttributes.tcpType;
  }

  /**
   * Related address for reflexive/relay candidates.
   * @type {string|null}
   */
  get relatedAddress() {
    return this._parsedAttributes.relatedAddress;
  }

  /**
   * Related port for reflexive/relay candidates.
   * @type {number|null}
   */
  get relatedPort() {
    return this._parsedAttributes.relatedPort;
  }

  /**
   * Converts candidate to JSON representation.
   * @returns {Object} JSON representation
   */
  toJSON() {
    const json = {
      candidate: this._candidate,
      sdpMid: this._sdpMid,
      sdpMLineIndex: this._sdpMLineIndex
    };

    if (this._usernameFragment) {
      json.usernameFragment = this._usernameFragment;
    }

    return json;
  }

  /**
   * Creates an RTCIceCandidate from a candidate string.
   * 
   * @param {string} candidateStr - ICE candidate string
   * @param {string|null} [sdpMid=null] - Media stream ID
   * @param {number|null} [sdpMLineIndex=0] - M-line index
   * @returns {RTCIceCandidate}
   */
  static fromString(candidateStr, sdpMid = null, sdpMLineIndex = 0) {
    return new RTCIceCandidate({
      candidate: candidateStr,
      sdpMid,
      sdpMLineIndex
    });
  }

  /**
   * Validates if a string is a valid candidate format.
   * 
   * @param {string} candidateStr - String to validate
   * @returns {boolean} True if valid candidate format
   */
  static isValid(candidateStr) {
    if (!candidateStr || typeof candidateStr !== 'string') {
      return false;
    }
    
    // Must start with "candidate:"
    if (!candidateStr.startsWith('candidate:')) {
      return false;
    }

    // Must have at least the minimum required fields
    const parts = candidateStr.substring(10).trim().split(/\s+/);
    return parts.length >= 8;
  }
}

module.exports = RTCIceCandidate;
