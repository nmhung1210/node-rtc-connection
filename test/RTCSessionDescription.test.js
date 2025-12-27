const assert = require('assert');
const { describe, it } = require('node:test');
const RTCSessionDescription = require('../src/RTCSessionDescription');

describe('RTCSessionDescription', () => {
  describe('constructor', () => {
    it('should create with empty object', () => {
      const desc = new RTCSessionDescription();
      assert.strictEqual(desc.type, '');
      assert.strictEqual(desc.sdp, '');
    });

    it('should create with type and sdp', () => {
      const desc = new RTCSessionDescription({
        type: 'offer',
        sdp: 'v=0\r\no=- 123 456 IN IP4 127.0.0.1'
      });
      assert.strictEqual(desc.type, 'offer');
      assert.ok(desc.sdp.includes('v=0'));
    });

    it('should throw on invalid type', () => {
      assert.throws(() => {
        new RTCSessionDescription({ type: 'invalid' });
      }, /Invalid type/);
    });
  });

  describe('properties', () => {
    it('should get and set type', () => {
      const desc = new RTCSessionDescription();
      desc.type = 'answer';
      assert.strictEqual(desc.type, 'answer');
    });

    it('should get and set sdp', () => {
      const desc = new RTCSessionDescription();
      desc.sdp = 'test sdp';
      assert.strictEqual(desc.sdp, 'test sdp');
    });

    it('should throw when setting invalid type', () => {
      const desc = new RTCSessionDescription({ type: 'offer' });
      assert.throws(() => {
        desc.type = 'badtype';
      }, /Invalid type/);
    });
  });

  describe('toJSON', () => {
    it('should return JSON representation', () => {
      const desc = new RTCSessionDescription({
        type: 'offer',
        sdp: 'test'
      });
      const json = desc.toJSON();
      assert.strictEqual(json.type, 'offer');
      assert.strictEqual(json.sdp, 'test');
    });
  });

  describe('valid types', () => {
    const validTypes = ['offer', 'answer', 'pranswer', 'rollback'];
    
    validTypes.forEach(type => {
      it(`should accept type: ${type}`, () => {
        const desc = new RTCSessionDescription({ type });
        assert.strictEqual(desc.type, type);
      });
    });
  });
});
