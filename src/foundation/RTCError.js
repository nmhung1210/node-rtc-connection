/**
 * @fileoverview RTCError - WebRTC-specific error types.
 *
 * Implements the W3C RTCError interface
 * (https://www.w3.org/TR/webrtc/#rtcerror-interface).
 *
 * Provides WebRTC-specific error types extending the standard Error class
 * with additional error detail types and metadata fields.
 * 
 * @license BSD-3-Clause
 * @author nmhung1210
 */

'use strict';

/**
 * RTCErrorDetailType enum - Standardized WebRTC error details.
 * Maps to RTCErrorDetailType from the WebRTC spec.
 * 
 * @readonly
 * @enum {string}
 */
const RTCErrorDetailType = Object.freeze({
  NONE: 'none',
  DATA_CHANNEL_FAILURE: 'data-channel-failure',
  DTLS_FAILURE: 'dtls-failure',
  FINGERPRINT_FAILURE: 'fingerprint-failure',
  SCTP_FAILURE: 'sctp-failure',
  SDP_SYNTAX_ERROR: 'sdp-syntax-error',
  HARDWARE_ENCODER_NOT_AVAILABLE: 'hardware-encoder-not-available',
  HARDWARE_ENCODER_ERROR: 'hardware-encoder-error',
  INVALID_STATE: 'invalid-state',
  INVALID_MODIFICATION: 'invalid-modification',
  INVALID_ACCESS_ERROR: 'invalid-access-error',
  OPERATION_ERROR: 'operation-error'
});

/**
 * RTCError extends Error with WebRTC-specific error details.
 * 
 * @extends Error
 */
class RTCError extends Error {
  /**
   * Creates a new RTCError.
   * 
   * @param {RTCErrorInit} [init={}] - Error initialization dictionary
   * @param {string} [init.errorDetail='none'] - Error detail type
   * @param {number} [init.sdpLineNumber] - SDP line number where error occurred
   * @param {number} [init.httpRequestStatusCode] - HTTP status code if relevant
   * @param {number} [init.sctpCauseCode] - SCTP cause code
   * @param {number} [init.receivedAlert] - TLS alert received
   * @param {number} [init.sentAlert] - TLS alert sent
   * @param {string} [message=''] - Error message
   */
  constructor(init = {}, message = '') {
    super(message);
    
    this.name = 'RTCError';
    
    // Maintain stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RTCError);
    }

    // Validate and set errorDetail
    const errorDetail = init.errorDetail || RTCErrorDetailType.NONE;
    if (typeof errorDetail !== 'string') {
      throw new TypeError('errorDetail must be a string');
    }
    
    /**
     * Specific error category.
     * @private {string}
     */
    this._errorDetail = errorDetail;

    // Optional numeric fields with validation
    this._sdpLineNumber = this._validateInteger(init.sdpLineNumber, 'sdpLineNumber');
    this._httpRequestStatusCode = this._validateInteger(init.httpRequestStatusCode, 'httpRequestStatusCode');
    this._sctpCauseCode = this._validateInteger(init.sctpCauseCode, 'sctpCauseCode');
    this._receivedAlert = this._validateUnsignedInteger(init.receivedAlert, 'receivedAlert');
    this._sentAlert = this._validateUnsignedInteger(init.sentAlert, 'sentAlert');
  }

  /**
   * Validates that a value is an integer or null/undefined.
   * @private
   * @param {*} value - Value to validate
   * @param {string} fieldName - Field name for error messages
   * @returns {number|null}
   * @throws {TypeError} If value is not an integer
   */
  _validateInteger(value, fieldName) {
    if (value === undefined || value === null) {
      return null;
    }
    const num = Number(value);
    if (!Number.isInteger(num)) {
      throw new TypeError(`${fieldName} must be an integer`);
    }
    return num;
  }

  /**
   * Validates that a value is an unsigned integer or null/undefined.
   * @private
   * @param {*} value - Value to validate
   * @param {string} fieldName - Field name for error messages
   * @returns {number|null}
   * @throws {TypeError} If value is not an unsigned integer
   */
  _validateUnsignedInteger(value, fieldName) {
    if (value === undefined || value === null) {
      return null;
    }
    const num = Number(value);
    if (!Number.isInteger(num) || num < 0) {
      throw new TypeError(`${fieldName} must be an unsigned integer`);
    }
    return num;
  }

  /**
   * RTCErrorDetailType - specific error category.
   * @type {string}
   */
  get errorDetail() {
    return this._errorDetail;
  }

  /**
   * SDP line number where the error occurred (if applicable).
   * @type {number|null}
   */
  get sdpLineNumber() {
    return this._sdpLineNumber;
  }

  /**
   * HTTP request status code (if applicable).
   * @type {number|null}
   */
  get httpRequestStatusCode() {
    return this._httpRequestStatusCode;
  }

  /**
   * SCTP cause code (if applicable).
   * @type {number|null}
   */
  get sctpCauseCode() {
    return this._sctpCauseCode;
  }

  /**
   * TLS alert value received (if applicable).
   * @type {number|null}
   */
  get receivedAlert() {
    return this._receivedAlert;
  }

  /**
   * TLS alert value sent (if applicable).
   * @type {number|null}
   */
  get sentAlert() {
    return this._sentAlert;
  }

  /**
   * Converts error to JSON representation.
   * @returns {Object} JSON representation of the error
   */
  toJSON() {
    const json = {
      name: this.name,
      message: this.message,
      errorDetail: this._errorDetail
    };

    if (this._sdpLineNumber !== null) {
      json.sdpLineNumber = this._sdpLineNumber;
    }
    if (this._httpRequestStatusCode !== null) {
      json.httpRequestStatusCode = this._httpRequestStatusCode;
    }
    if (this._sctpCauseCode !== null) {
      json.sctpCauseCode = this._sctpCauseCode;
    }
    if (this._receivedAlert !== null) {
      json.receivedAlert = this._receivedAlert;
    }
    if (this._sentAlert !== null) {
      json.sentAlert = this._sentAlert;
    }

    return json;
  }

  /**
   * Creates RTCError from a native WebRTC error object.
   * @param {Object} nativeError - Native error object
   * @param {string} [nativeError.error_detail] - Error detail type
   * @param {number} [nativeError.sctp_cause_code] - SCTP cause code
   * @param {string} [nativeError.message] - Error message
   * @returns {RTCError}
   */
  static fromNative(nativeError) {
    const init = {
      errorDetail: nativeError.error_detail || RTCErrorDetailType.NONE
    };

    if (nativeError.sctp_cause_code !== undefined) {
      init.sctpCauseCode = nativeError.sctp_cause_code;
    }

    return new RTCError(init, nativeError.message || 'Unknown error');
  }
}

// Export error detail types as static property
RTCError.DetailType = RTCErrorDetailType;

module.exports = RTCError;
