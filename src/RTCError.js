/**
 * RTCErrorEvent represents an error event.
 * Ported from Chromium's implementation.
 */
class RTCErrorEvent {
  constructor(type, eventInitDict = {}) {
    this._type = type;
    this._error = eventInitDict.error || null;
    this._bubbles = eventInitDict.bubbles || false;
    this._cancelable = eventInitDict.cancelable || false;
    this._timestamp = Date.now();
  }

  /**
   * The event type
   */
  get type() {
    return this._type;
  }

  /**
   * The error associated with the event
   */
  get error() {
    return this._error;
  }

  /**
   * Whether the event bubbles
   */
  get bubbles() {
    return this._bubbles;
  }

  /**
   * Whether the event is cancelable
   */
  get cancelable() {
    return this._cancelable;
  }

  /**
   * The timestamp when the event was created
   */
  get timeStamp() {
    return this._timestamp;
  }
}

/**
 * RTCError represents a WebRTC-specific error.
 */
class RTCError extends Error {
  constructor(errorDetail, message) {
    super(message);
    this.name = 'RTCError';
    this.errorDetail = errorDetail;
    this.sdpLineNumber = null;
    this.httpRequestStatusCode = null;
    this.sctpCauseCode = null;
    this.receivedAlert = null;
    this.sentAlert = null;
  }
}

module.exports = { RTCErrorEvent, RTCError };
