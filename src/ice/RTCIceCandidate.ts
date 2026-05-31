/**
 * @file RTCIceCandidate - ICE candidate representation.
 *
 * Implements the W3C RTCIceCandidate interface
 * (https://www.w3.org/TR/webrtc/#rtcicecandidate-interface).
 *
 * Represents an ICE (Interactive Connectivity Establishment) candidate that
 * describes a potential way to establish a connection with a peer.
 *
 * @license MIT
 * @author nmhung1210
 */

'use strict';

/**
 * Initialization dictionary for RTCIceCandidate.
 */
interface RTCIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/**
 * Parsed attributes extracted from an ICE candidate string.
 */
interface ParsedCandidateAttributes {
  foundation: string | null;
  component: string | null;
  protocol: string | null;
  priority: number | null;
  address: string | null;
  port: number | null;
  type: string | null;
  tcpType: string | null;
  relatedAddress: string | null;
  relatedPort: number | null;
}

/**
 * JSON representation of an RTCIceCandidate.
 */
interface RTCIceCandidateJSON {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string;
}

/**
 * RTCIceCandidate represents a potential method for establishing connectivity.
 *
 * ICE candidates are described using SDP (Session Description Protocol) syntax.
 * Each candidate describes a single address/port combination and transport protocol.
 */
class RTCIceCandidate {
  /**
   * SDP candidate string.
   * @private {string}
   */
  #candidate: string;

  /**
   * Media stream identification.
   * @private {string|null}
   */
  #sdpMid: string | null;

  /**
   * Media line index (zero-based).
   * @private {number|null}
   */
  #sdpMLineIndex: number | null;

  /**
   * ICE username fragment.
   * @private {string|null}
   */
  #usernameFragment: string | null;

  #parsedAttributes: ParsedCandidateAttributes;

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
  constructor(candidateInit: RTCIceCandidateInit = {}) {
    // Validate that at least one of sdpMid or sdpMLineIndex is present
    if (candidateInit.sdpMid === null && candidateInit.sdpMLineIndex === null) {
      throw new TypeError('sdpMid and sdpMLineIndex are both null');
    }

    this.#candidate = candidateInit.candidate || '';

    this.#sdpMid = candidateInit.sdpMid !== undefined ? candidateInit.sdpMid : null;

    this.#sdpMLineIndex = candidateInit.sdpMLineIndex !== undefined ?
      candidateInit.sdpMLineIndex : null;

    this.#usernameFragment = candidateInit.usernameFragment || null;

    // Parse candidate string for detailed attributes
    this.#parsedAttributes = this.#parseCandidate(this.#candidate);
  }

  /**
   * Parses an ICE candidate string to extract attributes.
   * Format: "candidate:foundation component protocol priority address port typ type [raddr reladdr] [rport relport]"
   *
   * @private
   * @param {string} candidateStr - Candidate string to parse
   * @returns {Object} Parsed attributes
   */
  #parseCandidate(candidateStr: string): ParsedCandidateAttributes {
    const attrs: ParsedCandidateAttributes = {
      foundation: null,
      component: null,
      protocol: null,
      priority: null,
      address: null,
      port: null,
      type: null,
      tcpType: null,
      relatedAddress: null,
      relatedPort: null,
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
    attrs.foundation = parts[0]!;
    attrs.component = parts[1]!;
    attrs.protocol = parts[2]!.toLowerCase();
    attrs.priority = parseInt(parts[3]!, 10);
    attrs.address = parts[4]!;
    attrs.port = parseInt(parts[5]!, 10);

    // parts[6] should be "typ"
    if (parts[6] === 'typ') {
      attrs.type = parts[7]!;
    }

    // Parse optional attributes
    for (let i = 8; i < parts.length; i += 2) {
      const key = parts[i];
      const value = parts[i + 1];

      if (key === 'raddr') {
        attrs.relatedAddress = value!;
      } else if (key === 'rport') {
        attrs.relatedPort = parseInt(value!, 10);
      } else if (key === 'tcptype') {
        attrs.tcpType = value!;
      }
    }

    return attrs;
  }

  /**
   * SDP candidate attribute containing the candidate description.
   * @type {string}
   */
  get candidate(): string {
    return this.#candidate;
  }

  /**
   * Media stream identification tag.
   * @type {string|null}
   */
  get sdpMid(): string | null {
    return this.#sdpMid;
  }

  /**
   * Index of the m-line in the SDP this candidate is associated with.
   * @type {number|null}
   */
  get sdpMLineIndex(): number | null {
    return this.#sdpMLineIndex;
  }

  /**
   * ICE username fragment.
   * @type {string|null}
   */
  get usernameFragment(): string | null {
    return this.#usernameFragment;
  }

  /**
   * Unique identifier for this candidate.
   * @type {string|null}
   */
  get foundation(): string | null {
    return this.#parsedAttributes.foundation;
  }

  /**
   * Component identifier (rtp=1, rtcp=2).
   * @type {string|null}
   */
  get component(): string | null {
    return this.#parsedAttributes.component;
  }

  /**
   * Priority value for this candidate.
   * Higher priority candidates are preferred.
   * @type {number|null}
   */
  get priority(): number | null {
    return this.#parsedAttributes.priority;
  }

  /**
   * IP address of this candidate.
   * @type {string|null}
   */
  get address(): string | null {
    return this.#parsedAttributes.address;
  }

  /**
   * Transport protocol (udp/tcp).
   * @type {string|null}
   */
  get protocol(): string | null {
    return this.#parsedAttributes.protocol;
  }

  /**
   * Port number.
   * @type {number|null}
   */
  get port(): number | null {
    return this.#parsedAttributes.port;
  }

  /**
   * Type of candidate (host, srflx, prflx, relay).
   * @type {string|null}
   */
  get type(): string | null {
    return this.#parsedAttributes.type;
  }

  /**
   * TCP candidate type (active, passive, so).
   * Only applicable for TCP candidates.
   * @type {string|null}
   */
  get tcpType(): string | null {
    return this.#parsedAttributes.tcpType;
  }

  /**
   * Related address for reflexive/relay candidates.
   * @type {string|null}
   */
  get relatedAddress(): string | null {
    return this.#parsedAttributes.relatedAddress;
  }

  /**
   * Related port for reflexive/relay candidates.
   * @type {number|null}
   */
  get relatedPort(): number | null {
    return this.#parsedAttributes.relatedPort;
  }

  /**
   * Converts candidate to JSON representation.
   * @returns {Object} JSON representation
   */
  toJSON(): RTCIceCandidateJSON {
    const json: RTCIceCandidateJSON = {
      candidate: this.#candidate,
      sdpMid: this.#sdpMid,
      sdpMLineIndex: this.#sdpMLineIndex,
    };

    if (this.#usernameFragment) {
      json.usernameFragment = this.#usernameFragment;
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
  static fromString(candidateStr: string, sdpMid: string | null = null, sdpMLineIndex: number | null = 0): RTCIceCandidate {
    return new RTCIceCandidate({
      candidate: candidateStr,
      sdpMid,
      sdpMLineIndex,
    });
  }

  /**
   * Validates if a string is a valid candidate format.
   *
   * @param {string} candidateStr - String to validate
   * @returns {boolean} True if valid candidate format
   */
  static isValid(candidateStr: string): boolean {
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

export default RTCIceCandidate;
export { RTCIceCandidate };
export type { RTCIceCandidateInit, ParsedCandidateAttributes, RTCIceCandidateJSON };
