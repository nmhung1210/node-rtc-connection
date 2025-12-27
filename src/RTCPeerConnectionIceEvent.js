/**
 * RTCPeerConnectionIceEvent is fired when an ICE candidate is available.
 * Ported from Chromium's implementation.
 */
class RTCPeerConnectionIceEvent {
  constructor(type, eventInitDict = {}) {
    this._type = type;
    this._candidate = eventInitDict.candidate || null;
    this._url = eventInitDict.url || null;
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
   * The RTCIceCandidate associated with the event
   */
  get candidate() {
    return this._candidate;
  }

  /**
   * The URL of the TURN or STUN server
   */
  get url() {
    return this._url;
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

module.exports = RTCPeerConnectionIceEvent;
