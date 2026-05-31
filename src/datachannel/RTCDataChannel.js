/**
 * @file RTCDataChannel.js
 * @description WebRTC DataChannel implementation for peer-to-peer data transfer.
 * @module datachannel/RTCDataChannel
 *
 * Implements the W3C RTCDataChannel interface
 * (https://www.w3.org/TR/webrtc/#rtcdatachannel).
 */

const EventEmitter = require('events');

/**
 * RTCDataChannelState - Current state of the data channel
 * @readonly
 * @enum {string}
 */
const RTCDataChannelState = Object.freeze({
  CONNECTING: 'connecting',
  OPEN: 'open',
  CLOSING: 'closing',
  CLOSED: 'closed'
});

/**
 * RTCDataChannelInit - Configuration for creating a data channel
 * @typedef {Object} RTCDataChannelInit
 * @property {boolean} [ordered=true] - Whether messages must arrive in order
 * @property {number} [maxPacketLifeTime] - Maximum packet lifetime in milliseconds
 * @property {number} [maxRetransmits] - Maximum number of retransmissions
 * @property {string} [protocol=''] - Subprotocol name
 * @property {boolean} [negotiated=false] - Whether channel was negotiated out-of-band
 * @property {number} [id] - Channel ID (required if negotiated is true)
 */

/**
 * @class RTCDataChannel
 * @extends EventEmitter
 * @description Represents a bidirectional data channel between peers.
 * Provides reliable or unreliable data transfer with configurable ordering.
 * 
 * Events:
 * - 'open': Fired when the channel opens
 * - 'message': Fired when a message is received
 * - 'bufferedamountlow': Fired when bufferedAmount drops below threshold
 * - 'error': Fired when an error occurs
 * - 'closing': Fired when the channel is closing
 * - 'close': Fired when the channel closes
 * 
 * @example
 * const dataChannel = peerConnection.createDataChannel('myChannel', {
 *   ordered: true,
 *   maxRetransmits: 3
 * });
 * 
 * dataChannel.on('open', () => {
 *   console.log('Channel opened');
 *   dataChannel.send('Hello!');
 * });
 * 
 * dataChannel.on('message', (event) => {
 *   console.log('Received:', event.data);
 * });
 */
class RTCDataChannel extends EventEmitter {
  /**
   * Create an RTCDataChannel instance.
   * @param {string} label - Channel label
   * @param {RTCDataChannelInit} [init] - Channel configuration
   */
  constructor(label, init = {}) {
    super();

    if (typeof label !== 'string') {
      throw new TypeError('label must be a string');
    }

    // Channel configuration
    this._label = label;
    this._ordered = init.ordered !== undefined ? init.ordered : true;
    this._maxPacketLifeTime = init.maxPacketLifeTime || null;
    this._maxRetransmits = init.maxRetransmits || null;
    this._protocol = init.protocol || '';
    this._negotiated = init.negotiated || false;
    this._id = init.id !== undefined ? init.id : null;

    // State
    this._readyState = RTCDataChannelState.CONNECTING;
    this._bufferedAmount = 0;
    this._bufferedAmountLowThreshold = 0;
    this._binaryType = 'arraybuffer'; // or 'blob'

    // Message queue for when not open
    this._messageQueue = [];
  }

  /**
   * Get the channel label.
   * @returns {string} Channel label
   */
  get label() {
    return this._label;
  }

  /**
   * Check if messages are delivered in order.
   * @returns {boolean} True if ordered
   */
  get ordered() {
    return this._ordered;
  }

  /**
   * Get the maximum packet lifetime in milliseconds.
   * @returns {number|null} Maximum lifetime or null if not set
   */
  get maxPacketLifeTime() {
    return this._maxPacketLifeTime;
  }

  /**
   * Get the maximum number of retransmissions.
   * @returns {number|null} Maximum retransmits or null if not set
   */
  get maxRetransmits() {
    return this._maxRetransmits;
  }

  /**
   * Get the subprotocol name.
   * @returns {string} Protocol name
   */
  get protocol() {
    return this._protocol;
  }

  /**
   * Check if the channel was negotiated out-of-band.
   * @returns {boolean} True if negotiated
   */
  get negotiated() {
    return this._negotiated;
  }

  /**
   * Get the channel ID.
   * @returns {number|null} Channel ID or null if not assigned
   */
  get id() {
    return this._id;
  }

  /**
   * Get the current state of the channel.
   * @returns {string} Channel state
   */
  get readyState() {
    return this._readyState;
  }

  /**
   * Get the number of bytes queued to send.
   * @returns {number} Buffered amount in bytes
   */
  get bufferedAmount() {
    return this._bufferedAmount;
  }

  /**
   * Get the threshold for bufferedamountlow event.
   * @returns {number} Threshold in bytes
   */
  get bufferedAmountLowThreshold() {
    return this._bufferedAmountLowThreshold;
  }

  /**
   * Set the threshold for bufferedamountlow event.
   * @param {number} value - Threshold in bytes
   */
  set bufferedAmountLowThreshold(value) {
    this._bufferedAmountLowThreshold = value;
  }

  /**
   * Get the binary data type.
   * @returns {string} 'arraybuffer' or 'blob'
   */
  get binaryType() {
    return this._binaryType;
  }

  /**
   * Set the binary data type.
   * @param {string} value - 'arraybuffer' or 'blob'
   * @throws {TypeError} If value is invalid
   */
  set binaryType(value) {
    if (value !== 'arraybuffer' && value !== 'blob') {
      throw new TypeError('binaryType must be "arraybuffer" or "blob"');
    }
    this._binaryType = value;
  }

  /**
   * Check if the channel is reliable (deprecated).
   * @returns {boolean} True if ordered and no packet lifetime/retransmit limits
   * @deprecated Use ordered, maxPacketLifeTime, and maxRetransmits instead
   */
  get reliable() {
    return this._ordered && 
           this._maxPacketLifeTime === null && 
           this._maxRetransmits === null;
  }

  /**
   * Send a message through the channel.
   * @param {string|ArrayBuffer|ArrayBufferView|Blob} data - Data to send
   * @throws {Error} If channel is not open or data is invalid
   */
  send(data) {
    if (this._readyState !== RTCDataChannelState.OPEN) {
      throw new Error('RTCDataChannel.readyState is not "open"');
    }

    let dataToSend;
    let byteLength = 0;
    let isBinary;

    if (typeof data === 'string') {
      dataToSend = Buffer.from(data, 'utf8');
      byteLength = dataToSend.length;
      isBinary = false;
    } else if (data instanceof ArrayBuffer) {
      dataToSend = Buffer.from(data);
      byteLength = data.byteLength;
      isBinary = true;
    } else if (ArrayBuffer.isView(data)) {
      dataToSend = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      byteLength = data.byteLength;
      isBinary = true;
    } else if (Buffer.isBuffer(data)) {
      dataToSend = data;
      byteLength = data.length;
      isBinary = true;
    } else if (data && typeof data.arrayBuffer === 'function') {
      // Blob-like object
      throw new Error('Blob sending not yet implemented');
    } else {
      throw new TypeError('Invalid data type');
    }

    // The sender carries the binary flag so the peer can reconstruct the right
    // JS type; binary is transmitted as raw bytes (no JSON), fixing prior
    // corruption of Buffer/ArrayBuffer payloads.
    if (!this._sender) {
      throw new Error('Data channel not connected to a transport');
    }

    // Update buffered amount, then decrement once the transport accepts it.
    this._bufferedAmount += byteLength;
    try {
      this._sender(dataToSend, isBinary);
      this._bufferedAmount = Math.max(0, this._bufferedAmount - byteLength);
      this._emitBufferedAmountLow();
    } catch (err) {
      this._bufferedAmount = Math.max(0, this._bufferedAmount - byteLength);
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Emit bufferedamountlow if appropriate
   * @private
   */
  _emitBufferedAmountLow() {
    if (this._bufferedAmount <= this._bufferedAmountLowThreshold) {
      this.emit('bufferedamountlow');
    }
  }

  /**
   * Close the data channel.
   */
  close() {
    if (this._readyState === RTCDataChannelState.CLOSING || 
        this._readyState === RTCDataChannelState.CLOSED) {
      return;
    }

    this._setState(RTCDataChannelState.CLOSING);
    
    // Transition to closed asynchronously
    setImmediate(() => {
      if (this._readyState === RTCDataChannelState.CLOSING) {
        this._setState(RTCDataChannelState.CLOSED);
      }
    });
  }

  /**
   * Set the channel state and emit appropriate events.
   * @param {string} newState - New state
   * @private
   */
  _setState(newState) {
    const oldState = this._readyState;
    if (oldState === newState) {
      return;
    }

    this._readyState = newState;

    // Emit state-specific events
    if (newState === RTCDataChannelState.OPEN) {
      this.emit('open');
    } else if (newState === RTCDataChannelState.CLOSING) {
      this.emit('closing');
    } else if (newState === RTCDataChannelState.CLOSED) {
      this.emit('close');
    }
  }

  /**
   * Set channel to open state (internal use).
   * @private
   */
  _setStateToOpen() {
    this._setState(RTCDataChannelState.OPEN);
  }

  /**
   * Deliver a received message to listeners (internal use).
   *
   * Mirrors the browser RTCDataChannel: text frames surface as a string;
   * binary frames surface as an ArrayBuffer (binaryType 'arraybuffer') or a
   * Node Buffer (binaryType 'blob', which we approximate with Buffer since
   * Node has no Blob in older runtimes).
   *
   * @param {Buffer} data - Raw received bytes
   * @param {boolean} isBinary - Whether the frame was binary
   * @private
   */
  _receiveMessage(data, isBinary) {
    let payload;
    if (!isBinary) {
      payload = data.toString('utf8');
    } else if (this._binaryType === 'arraybuffer') {
      payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
      payload = data;
    }
    this.emit('message', { data: payload });
  }

  /**
   * Attach the transport sender (internal use). The sender is called with
   * (Buffer, isBinary) and is responsible for SCTP delivery.
   * @param {(data:Buffer, isBinary:boolean)=>void} sender
   * @private
   */
  _setSender(sender) {
    this._sender = sender;
  }

  /**
   * Set the channel ID (internal use).
   * @param {number} id - Channel ID
   * @private
   */
  _setId(id) {
    this._id = id;
  }
}

module.exports = {
  RTCDataChannel,
  RTCDataChannelState
};
