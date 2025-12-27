/**
 * @file RTCSessionDescription.js
 * @description Session Description Protocol (SDP) representation
 * @module sdp/RTCSessionDescription
 * 
 * Ported from Chromium's RTCSessionDescription implementation:
 * - cc/rtc_session_description.idl
 * - cc/rtc_session_description.h
 */

'use strict';

/**
 * RTCSdpType - Types of session descriptions
 * @readonly
 * @enum {string}
 */
const RTCSdpType = Object.freeze({
  OFFER: 'offer',
  PRANSWER: 'pranswer',
  ANSWER: 'answer',
  ROLLBACK: 'rollback'
});

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
class RTCSessionDescription {
  /**
   * Create an RTCSessionDescription instance.
   * @param {Object} [init] - Session description init
   * @param {string} [init.type] - SDP type (offer/answer/pranswer/rollback)
   * @param {string} [init.sdp] - SDP string
   */
  constructor(init = {}) {
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
  get type() {
    return this._type;
  }

  /**
   * Set the SDP type.
   * @param {string} value - SDP type
   */
  set type(value) {
    if (value && !Object.values(RTCSdpType).includes(value)) {
      throw new TypeError(`Invalid SDP type: ${value}`);
    }
    this._type = value;
  }

  /**
   * Get the SDP string.
   * @returns {string|null} SDP string
   */
  get sdp() {
    return this._sdp;
  }

  /**
   * Set the SDP string.
   * @param {string} value - SDP string
   */
  set sdp(value) {
    this._sdp = value;
  }

  /**
   * Convert to JSON representation.
   * @returns {Object} JSON representation
   */
  toJSON() {
    return {
      type: this._type,
      sdp: this._sdp
    };
  }
}

module.exports = {
  RTCSessionDescription,
  RTCSdpType
};
