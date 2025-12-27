/**
 * RTCDataChannelEvent is fired when a data channel is added to the connection.
 * Ported from Chromium's implementation.
 */
class RTCDataChannelEvent {
  constructor(type, eventInitDict = {}) {
    this._type = type;
    this._channel = eventInitDict.channel || null;
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
   * The RTCDataChannel associated with the event
   */
  get channel() {
    return this._channel;
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

module.exports = RTCDataChannelEvent;
