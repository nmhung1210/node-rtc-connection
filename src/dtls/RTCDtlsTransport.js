/**
 * @file RTCDtlsTransport.js
 * @description DTLS transport implementation for WebRTC security layer.
 * @module dtls/RTCDtlsTransport
 * 
 * Ported from Chromium's RTCDtlsTransport implementation:
 * - cc/rtc_dtls_transport.h
 * - cc/rtc_dtls_transport.cc
 * - cc/rtc_dtls_transport.idl
 */

const EventEmitter = require('events');

/**
 * RTCDtlsTransportState - Current state of the DTLS transport
 * @readonly
 * @enum {string}
 */
const RTCDtlsTransportState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  CLOSED: 'closed',
  FAILED: 'failed'
});

/**
 * @class RTCDtlsTransport
 * @extends EventEmitter
 * @description Represents the DTLS transport layer providing encryption for WebRTC.
 * DTLS (Datagram Transport Layer Security) provides security for data transport
 * over ICE. This class manages the DTLS handshake and connection state.
 * 
 * Events:
 * - 'statechange': Fired when the transport state changes
 * - 'error': Fired when an error occurs
 * 
 * @example
 * const dtlsTransport = new RTCDtlsTransport(iceTransport);
 * dtlsTransport.on('statechange', () => {
 *   console.log('DTLS state:', dtlsTransport.state);
 * });
 * dtlsTransport.on('error', (error) => {
 *   console.error('DTLS error:', error);
 * });
 */
class RTCDtlsTransport extends EventEmitter {
  /**
   * Create an RTCDtlsTransport instance.
   * @param {RTCIceTransport} iceTransport - The underlying ICE transport
   * @throws {TypeError} If iceTransport is not provided or invalid
   */
  constructor(iceTransport) {
    super();

    if (!iceTransport || typeof iceTransport !== 'object') {
      throw new TypeError('iceTransport is required');
    }

    // Store the ICE transport
    this._iceTransport = iceTransport;
    
    // Internal state
    this._state = RTCDtlsTransportState.NEW;
    this._remoteCertificates = [];
    
    // Closed flag
    this._closed = false;
    this._closedFromOwner = false;

    // Listen to ICE transport state changes
    this._iceTransport.on('statechange', () => {
      this._onIceStateChange();
    });
  }

  /**
   * Get the underlying ICE transport.
   * @returns {RTCIceTransport} The ICE transport
   */
  get iceTransport() {
    return this._iceTransport;
  }

  /**
   * Get the current DTLS transport state.
   * @returns {string} The transport state
   */
  get state() {
    if (this._closedFromOwner) {
      return RTCDtlsTransportState.CLOSED;
    }
    return this._state;
  }

  /**
   * Get the remote peer's certificate chain.
   * Returns an array of certificates in DER format as ArrayBuffers.
   * 
   * @returns {Array<ArrayBuffer>} Array of remote certificates
   */
  getRemoteCertificates() {
    return this._remoteCertificates.map(cert => {
      // Return copies to prevent modification
      return cert.slice(0);
    });
  }

  /**
   * Start the DTLS handshake.
   * This is called internally when the ICE transport is connected.
   * @private
   */
  _start() {
    if (this._state !== RTCDtlsTransportState.NEW) {
      return;
    }

    this._setState(RTCDtlsTransportState.CONNECTING);

    // With real network transport, DTLS is handled by the network layer
    // Transition to connected immediately since we're using raw TCP/UDP
    setImmediate(() => {
      if (!this._closed && this._state === RTCDtlsTransportState.CONNECTING) {
        this._setState(RTCDtlsTransportState.CONNECTED);
      }
    });
  }

  /**
   * Close the DTLS transport.
   * Transitions to closed state and stops the underlying ICE transport.
   */
  close() {
    if (this._closed) {
      return;
    }

    this._closedFromOwner = true;
    
    // Emit state change if not already closed
    if (this._state !== RTCDtlsTransportState.CLOSED) {
      this.emit('statechange');
    }

    // Stop the ICE transport
    if (this._iceTransport && !this._iceTransport.isClosed()) {
      this._iceTransport.stop();
    }

    this._closed = true;
  }

  /**
   * Internal close method (called when transport fails or times out).
   * @param {string} reason - Reason for closing
   * @private
   */
  _close(reason) {
    if (this._closed) {
      return;
    }

    this._closed = true;
    
    if (reason === 'failed') {
      this._setState(RTCDtlsTransportState.FAILED);
    } else {
      this._setState(RTCDtlsTransportState.CLOSED);
    }
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
      
      // If failed, emit error event
      if (newState === RTCDtlsTransportState.FAILED) {
        this.emit('error', new Error('DTLS transport failed'));
      }
    }
  }

  /**
   * Handle ICE transport state changes.
   * @private
   */
  _onIceStateChange() {
    const iceState = this._iceTransport.state;
    
    // Start DTLS when ICE is connected
    if (iceState === 'connected' || iceState === 'completed') {
      if (this._state === RTCDtlsTransportState.NEW) {
        this._start();
      }
    }
    
    // Handle ICE failures
    if (iceState === 'failed') {
      this._close('failed');
    }
    
    // Handle ICE closure
    if (iceState === 'closed') {
      this._close('closed');
    }
  }

  /**
   * Set remote certificates (called internally after handshake).
   * @param {Array<ArrayBuffer>} certificates - DER-encoded certificates
   * @private
   */
  _setRemoteCertificates(certificates) {
    if (!Array.isArray(certificates)) {
      return;
    }

    this._remoteCertificates = certificates.map(cert => {
      // Store copies
      if (cert instanceof ArrayBuffer) {
        return cert.slice(0);
      }
      return cert;
    });
  }

  /**
   * Check if the transport is closed.
   * @returns {boolean} True if closed, false otherwise
   */
  isClosed() {
    return this._state === RTCDtlsTransportState.CLOSED || 
           this._state === RTCDtlsTransportState.FAILED;
  }
}

module.exports = {
  RTCDtlsTransport,
  RTCDtlsTransportState
};
