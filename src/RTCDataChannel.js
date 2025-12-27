const EventEmitter = require('events');

/**
 * RTCDataChannel represents a bidirectional data channel between two peers.
 * Ported from Chromium's implementation, DataChannel-only functionality.
 */
class RTCDataChannel extends EventEmitter {
  constructor(nativeChannel, peerConnectionHandler) {
    super();
    
    this._nativeChannel = nativeChannel;
    this._peerConnectionHandler = peerConnectionHandler;
    this._state = 'connecting';
    this._binaryType = 'arraybuffer';
    this._bufferedAmount = 0;
    this._bufferedAmountLowThreshold = 0;
    this._closed = false;
    this._scheduledEvents = [];
    
    // Setup native channel observers
    this._setupObservers();
  }

  /**
   * The label specified when creating the data channel
   */
  get label() {
    return this._nativeChannel ? this._nativeChannel.label : '';
  }

  /**
   * Whether the channel is ordered or allows out-of-order delivery
   */
  get ordered() {
    return this._nativeChannel ? this._nativeChannel.ordered : true;
  }

  /**
   * Maximum packet lifetime in milliseconds
   */
  get maxPacketLifeTime() {
    if (!this._nativeChannel) return null;
    const lifetime = this._nativeChannel.maxPacketLifeTime;
    return lifetime >= 0 ? lifetime : null;
  }

  /**
   * Maximum number of retransmit attempts
   */
  get maxRetransmits() {
    if (!this._nativeChannel) return null;
    const retransmits = this._nativeChannel.maxRetransmits;
    return retransmits >= 0 ? retransmits : null;
  }

  /**
   * Subprotocol name
   */
  get protocol() {
    return this._nativeChannel ? this._nativeChannel.protocol : '';
  }

  /**
   * Whether the channel was negotiated by the application or the WebRTC layer
   */
  get negotiated() {
    return this._nativeChannel ? this._nativeChannel.negotiated : false;
  }

  /**
   * The ID for this data channel
   */
  get id() {
    if (!this._nativeChannel) return null;
    const channelId = this._nativeChannel.id;
    return channelId >= 0 ? channelId : null;
  }

  /**
   * The state of the data channel
   * Values: 'connecting', 'open', 'closing', 'closed'
   */
  get readyState() {
    return this._state;
  }

  /**
   * The number of bytes currently queued to be sent
   */
  get bufferedAmount() {
    return this._bufferedAmount;
  }

  /**
   * Threshold for the bufferedAmount at which bufferedamountlow event fires
   */
  get bufferedAmountLowThreshold() {
    return this._bufferedAmountLowThreshold;
  }

  set bufferedAmountLowThreshold(value) {
    this._bufferedAmountLowThreshold = value;
  }

  /**
   * Format for received binary data: 'blob' or 'arraybuffer'
   */
  get binaryType() {
    return this._binaryType;
  }

  set binaryType(value) {
    if (value !== 'blob' && value !== 'arraybuffer') {
      throw new Error('binaryType must be either "blob" or "arraybuffer"');
    }
    this._binaryType = value;
  }

  /**
   * Send data over the channel
   * @param {string|ArrayBuffer|ArrayBufferView} data - Data to send
   */
  send(data) {
    if (this._state !== 'open') {
      throw new Error('RTCDataChannel.send() called on a channel that is not open');
    }

    if (!this._nativeChannel) {
      throw new Error('Native data channel is not available');
    }

    let buffer;
    let isBinary = false;

    if (typeof data === 'string') {
      buffer = Buffer.from(data, 'utf8');
      isBinary = false;
    } else if (data instanceof ArrayBuffer) {
      buffer = Buffer.from(data);
      isBinary = true;
    } else if (ArrayBuffer.isView(data)) {
      buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      isBinary = true;
    } else {
      throw new Error('Unsupported data type');
    }

    const length = buffer.length;
    
    // Validate send length
    if (length > 65536) { // Maximum WebRTC message size
      throw new Error('Message too long');
    }

    this._bufferedAmount += length;
    
    // Send through native channel
    try {
      this._nativeChannel.send({
        data: buffer,
        binary: isBinary
      });
    } catch (error) {
      throw new Error(`Failed to send data: ${error.message}`);
    }
  }

  /**
   * Close the data channel
   */
  close() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    if (this._nativeChannel) {
      this._nativeChannel.close();
    }

    if (this._state === 'closing' || this._state === 'closed') {
      return;
    }

    this._setState('closing');
  }

  /**
   * Setup observers for the native channel
   * @private
   */
  _setupObservers() {
    if (!this._nativeChannel) {
      return;
    }

    // State change observer
    this._nativeChannel.on('statechange', (state) => {
      this._onStateChange(state);
    });

    // Message observer
    this._nativeChannel.on('message', (buffer) => {
      this._onMessage(buffer);
    });

    // Buffered amount change observer
    this._nativeChannel.on('bufferedamountlow', (amount) => {
      this._onBufferedAmountChange(amount);
    });

    // Error observer
    this._nativeChannel.on('error', (error) => {
      this.emit('error', error);
    });
  }

  /**
   * Handle state change from native channel
   * @private
   */
  _onStateChange(state) {
    let newState;
    
    switch (state) {
      case 0: // kConnecting
        newState = 'connecting';
        break;
      case 1: // kOpen
        newState = 'open';
        this.emit('open');
        break;
      case 2: // kClosing
        newState = 'closing';
        this.emit('closing');
        break;
      case 3: // kClosed
        newState = 'closed';
        this.emit('close');
        break;
      default:
        return;
    }
    
    // Only update state if it actually changed
    if (this._readyState !== newState) {
      this._setState(newState);
    }
  }

  /**
   * Handle incoming message from native channel
   * @private
   */
  _onMessage(buffer) {
    if (this._state !== 'open') {
      return;
    }

    let data;
    if (buffer.binary) {
      if (this._binaryType === 'arraybuffer') {
        data = buffer.data.buffer.slice(
          buffer.data.byteOffset,
          buffer.data.byteOffset + buffer.data.byteLength
        );
      } else {
        // For 'blob' type, we'll just pass the buffer
        // In a browser environment, this would be converted to a Blob
        data = buffer.data;
      }
    } else {
      data = buffer.data.toString('utf8');
    }

    this.emit('message', { data });
  }

  /**
   * Handle buffered amount change from native channel
   * @private
   */
  _onBufferedAmountChange(newAmount) {
    const previousAmount = this._bufferedAmount;
    this._bufferedAmount = newAmount;

    if (previousAmount > this._bufferedAmountLowThreshold &&
        newAmount <= this._bufferedAmountLowThreshold) {
      this.emit('bufferedamountlow');
    }
  }

  /**
   * Set the channel state
   * @private
   */
  _setState(state) {
    if (this._state === state) {
      return;
    }
    this._state = state;
  }

  /**
   * Set state to open without dispatching event (used for remote channels)
   */
  setStateToOpenWithoutEvent() {
    this._setState('open');
  }

  /**
   * Dispatch open event (used for remote channels)
   */
  dispatchOpenEvent() {
    this.emit('open');
  }

  /**
   * Dispose of resources
   */
  dispose() {
    if (this._nativeChannel) {
      this._nativeChannel.removeAllListeners();
      this._nativeChannel = null;
    }
    this._peerConnectionHandler = null;
    this.removeAllListeners();
  }
}

module.exports = RTCDataChannel;
