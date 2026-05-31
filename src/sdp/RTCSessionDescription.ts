/**
 * @file RTCSessionDescription.ts
 * @description Session Description Protocol (SDP) representation
 * @module sdp/RTCSessionDescription
 *
 * Implements the W3C RTCSessionDescription interface
 * (https://www.w3.org/TR/webrtc/#rtcsessiondescription-class).
 */

'use strict';

/**
 * RTCSdpType - Types of session descriptions
 * @readonly
 * @enum {string}
 */
export const RTCSdpType: Readonly<Record<string, string>> = Object.freeze({
  OFFER: 'offer',
  PRANSWER: 'pranswer',
  ANSWER: 'answer',
  ROLLBACK: 'rollback'
});

/**
 * Session description init object.
 */
export interface RTCSessionDescriptionInit {
  type?: string;
  sdp?: string;
}

/**
 * JSON representation of an RTCSessionDescription.
 */
export interface RTCSessionDescriptionJSON {
  type: string | null;
  sdp: string | null;
}

/**
 * @class RTCSessionDescription
 * @description Represents a WebRTC session description (offer/answer)
 *
 * @example
 * const desc = new RTCSessionDescription({
 *   type: 'offer',
 *   sdp: 'v=0\r\no=- 123456 2 IN IP4 127.0.0.1\r\n...'
 * });
 */
export class RTCSessionDescription {
  private _type: string | null;
  private _sdp: string | null;

  /**
   * Create an RTCSessionDescription instance.
   * @param {Object} [init] - Session description init
   * @param {string} [init.type] - SDP type (offer/answer/pranswer/rollback)
   * @param {string} [init.sdp] - SDP string
   */
  constructor(init: RTCSessionDescriptionInit = {}) {
    this._type = init.type || null;
    this._sdp = init.sdp || null;

    // Validate type if provided
    if (this._type && !Object.values(RTCSdpType).includes(this._type)) {
      throw new TypeError(`Invalid SDP type: ${this._type}`);
    }
  }

  /**
   * Get the SDP type.
   * @returns {string|null} SDP type
   */
  get type(): string | null {
    return this._type;
  }

  /**
   * Set the SDP type.
   * @param {string} value - SDP type
   */
  set type(value: string | null) {
    if (value && !Object.values(RTCSdpType).includes(value)) {
      throw new TypeError(`Invalid SDP type: ${value}`);
    }
    this._type = value;
  }

  /**
   * Get the SDP string.
   * @returns {string|null} SDP string
   */
  get sdp(): string | null {
    return this._sdp;
  }

  /**
   * Set the SDP string.
   * @param {string} value - SDP string
   */
  set sdp(value: string | null) {
    this._sdp = value;
  }

  /**
   * Convert to JSON representation.
   * @returns {Object} JSON representation
   */
  toJSON(): RTCSessionDescriptionJSON {
    return {
      type: this._type,
      sdp: this._sdp
    };
  }
}
