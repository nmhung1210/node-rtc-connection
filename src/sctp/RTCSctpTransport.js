/**
 * @file RTCSctpTransport.js
 * @description SCTP transport implementation for WebRTC data channels.
 * @module sctp/RTCSctpTransport
 * 
 * Ported from Chromium's RTCSctpTransport implementation:
 * - cc/rtc_sctp_transport.h
 * - cc/rtc_sctp_transport.cc
 * - cc/rtc_sctp_transport.idl
 */

const EventEmitter = require('events');

/**
 * RTCSctpTransportState - Current state of the SCTP transport
 * @readonly
 * @enum {string}
 */
const RTCSctpTransportState = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSED: 'closed'
});

/**
 * Default SCTP configuration values
 * @private
 */
const SCTP_DEFAULTS = {
  MAX_MESSAGE_SIZE: 256 * 1024, // 256 KB default
  MAX_CHANNELS: 65535 // Maximum number of SCTP streams
};

/**
 * @class RTCSctpTransport
 * @extends EventEmitter
 * @description Represents the SCTP transport layer for WebRTC data channels.
 * SCTP (Stream Control Transmission Protocol) provides reliable, message-oriented
 * transport over DTLS for data channels.
 * 
 * Events:
 * - 'statechange': Fired when the transport state changes
 * 
 * @example
 * const sctpTransport = new RTCSctpTransport(dtlsTransport);
 * sctpTransport.on('statechange', () => {
 *   console.log('SCTP state:', sctpTransport.state);
 *   console.log('Max message size:', sctpTransport.maxMessageSize);
 * });
 */
class RTCSctpTransport extends EventEmitter {
  /**
   * Create an RTCSctpTransport instance.
   * @param {RTCDtlsTransport} dtlsTransport - The underlying DTLS transport
   * @param {Object} [options] - SCTP configuration options
   * @param {number} [options.maxMessageSize] - Maximum message size in bytes
   * @param {number} [options.maxChannels] - Maximum number of channels
   * @throws {TypeError} If dtlsTransport is not provided or invalid
   */
  constructor(dtlsTransport, options = {}) {
    super();

    if (!dtlsTransport || typeof dtlsTransport !== 'object') {
      throw new TypeError('dtlsTransport is required');
    }

    // Store the DTLS transport
    this._dtlsTransport = dtlsTransport;
    
    // Internal state
    this._state = RTCSctpTransportState.CONNECTING;
    
    // SCTP configuration
    // Keep null if explicitly passed, otherwise use default
    if (options.maxMessageSize === null) {
      this._maxMessageSize = null;
    } else {
      this._maxMessageSize = options.maxMessageSize || SCTP_DEFAULTS.MAX_MESSAGE_SIZE;
    }
    this._maxChannels = options.maxChannels !== undefined ? options.maxChannels : SCTP_DEFAULTS.MAX_CHANNELS;
    
    // Closed flags
    this._closed = false;
    this._closedFromOwner = false;
    this._startCompleted = false;

    // Listen to DTLS transport state changes
    this._dtlsTransport.on('statechange', () => {
      this._onDtlsStateChange();
    });

    // Start SCTP if DTLS is already connected
    if (this._dtlsTransport.state === 'connected') {
      this._start();
    }
  }

  /**
   * Get the underlying DTLS transport.
   * @returns {RTCDtlsTransport} The DTLS transport
   */
  get transport() {
    return this._dtlsTransport;
  }

  /**
   * Get the current SCTP transport state.
   * @returns {string} The transport state
   */
  get state() {
    if (this._closedFromOwner) {
      return RTCSctpTransportState.CLOSED;
    }
    return this._state;
  }

  /**
   * Get the maximum message size in bytes.
   * This represents the maximum size of data that can be sent in a single message.
   * 
   * @returns {number} Maximum message size in bytes, or Infinity if unlimited
   */
  get maxMessageSize() {
    // Return Infinity if explicitly null or undefined (unlimited)
    if (this._maxMessageSize === null) {
      return Infinity;
    }
    return this._maxMessageSize;
  }

  /**
   * Get the maximum number of channels.
   * This represents the maximum number of data channels that can be opened.
   * 
   * @returns {number|null} Maximum number of channels, or null if unknown
   */
  get maxChannels() {
    return this._maxChannels;
  }

  /**
   * Start the SCTP association.
   * Called internally when DTLS is connected.
   * @private
   */
  _start() {
    if (this._startCompleted || this._closed) {
      return;
    }

    this._startCompleted = true;

    // With real network transport, SCTP is handled by the network layer
    // Transition to connected immediately since we're using raw TCP/UDP
    setImmediate(() => {
      if (!this._closed && this._state === RTCSctpTransportState.CONNECTING) {
        this._setState(RTCSctpTransportState.CONNECTED);
      }
    });
  }

  /**
   * Close the SCTP transport.
   * Called by the owning peer connection when it closes.
   */
  close() {
    if (this._closed) {
      return;
    }

    this._closedFromOwner = true;
    this._closed = true;
    
    // Emit state change if not already closed
    if (this._state !== RTCSctpTransportState.CLOSED) {
      this._state = RTCSctpTransportState.CLOSED;
      this.emit('statechange');
    }
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
    this._setState(RTCSctpTransportState.CLOSED);
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
   * Handle DTLS transport state changes.
   * @private
   */
  _onDtlsStateChange() {
    const dtlsState = this._dtlsTransport.state;
    
    // Start SCTP when DTLS is connected
    if (dtlsState === 'connected' && !this._startCompleted) {
      this._start();
    }
    
    // Close SCTP when DTLS closes or fails
    if (dtlsState === 'closed' || dtlsState === 'failed') {
      this._close('dtls-closed');
    }
  }

  /**
   * Update SCTP configuration.
   * @param {Object} info - SCTP transport information
   * @param {number} [info.maxMessageSize] - Maximum message size
   * @param {number} [info.maxChannels] - Maximum number of channels
   * @private
   */
  _updateConfiguration(info) {
    if (info.maxMessageSize !== undefined) {
      this._maxMessageSize = info.maxMessageSize;
    }
    if (info.maxChannels !== undefined) {
      this._maxChannels = info.maxChannels;
    }
  }

  /**
   * Check if the transport is closed.
   * @returns {boolean} True if closed, false otherwise
   */
  isClosed() {
    return this._state === RTCSctpTransportState.CLOSED;
  }
}

module.exports = {
  RTCSctpTransport,
  RTCSctpTransportState
};
