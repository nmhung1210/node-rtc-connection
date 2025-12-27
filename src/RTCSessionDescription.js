/**
 * RTCSessionDescription represents a session description.
 * Ported from Chromium's implementation.
 */
class RTCSessionDescription {
  constructor(descriptionInitDict = {}) {
    this._type = descriptionInitDict.type || '';
    this._sdp = descriptionInitDict.sdp || '';
    
    // Validate type
    const validTypes = ['offer', 'answer', 'pranswer', 'rollback'];
    if (this._type && !validTypes.includes(this._type)) {
      throw new Error(`Invalid type: ${this._type}`);
    }
  }

  /**
   * The type of session description
   * Values: 'offer', 'answer', 'pranswer', 'rollback'
   */
  get type() {
    return this._type;
  }

  set type(value) {
    const validTypes = ['offer', 'answer', 'pranswer', 'rollback'];
    if (value && !validTypes.includes(value)) {
      throw new Error(`Invalid type: ${value}`);
    }
    this._type = value;
  }

  /**
   * The SDP string
   */
  get sdp() {
    return this._sdp;
  }

  set sdp(value) {
    this._sdp = value || '';
  }

  /**
   * Convert to JSON
   */
  toJSON() {
    return {
      type: this._type,
      sdp: this._sdp
    };
  }

  /**
   * Convert to string
   */
  toString() {
    return `RTCSessionDescription { type: "${this._type}", sdp: "${this._sdp.substring(0, 50)}..." }`;
  }
}

module.exports = RTCSessionDescription;
