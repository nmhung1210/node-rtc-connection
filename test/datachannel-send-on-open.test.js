/**
 * @file datachannel-send-on-open.test.js
 * @description Test that data channel has _send method when 'open' event fires
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { RTCDataChannel } = require('../src/index');

describe('Data Channel Send on Open', () => {
  it('should have _send method defined before open event fires', () => {
    return new Promise((resolve, reject) => {
      const channel = new RTCDataChannel('test');
      
      channel.on('open', () => {
        try {
          // Verify _send is defined when open event fires
          assert.ok(channel._send, 'channel._send should be defined when open fires');
          assert.strictEqual(typeof channel._send, 'function', 'channel._send should be a function');
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      // Simulate connecting channel to network (what RTCPeerConnection does)
      channel._send = async (data) => {
        // Mock send function
        return Promise.resolve();
      };
      
      // Then open the channel (this is the correct order after the fix)
      channel._setStateToOpen();
    });
  });

  it('should throw error if send() called before _send is set', () => {
    const channel = new RTCDataChannel('test');
    
    // Directly set to open without setting _send (wrong order)
    channel._setStateToOpen();
    
    // Should throw because _send is not set
    assert.throws(() => {
      channel.send('test data');
    }, {
      message: 'Data channel not connected to network transport'
    });
  });

  it('should not throw if send() called after _send is set', () => {
    const channel = new RTCDataChannel('test');
    
    // Correct order: set _send first
    channel._send = async (data) => Promise.resolve();
    
    // Then open
    channel._setStateToOpen();
    
    // Should not throw
    assert.doesNotThrow(() => {
      channel.send('test data');
    });
  });

  it('should allow sending immediately in open handler if _send is set first', () => {
    return new Promise((resolve, reject) => {
      const channel = new RTCDataChannel('test');
      
      channel.on('open', () => {
        try {
          // This should not throw
          assert.doesNotThrow(() => {
            channel.send('test data');
          });
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      // Correct order: set _send BEFORE opening
      channel._send = async (data) => Promise.resolve();
      channel._setStateToOpen();
    });
  });

  it('should fail to send in open handler if _send is set after (wrong order)', () => {
    return new Promise((resolve) => {
      const channel = new RTCDataChannel('test');
      let errorThrown = false;
      
      channel.on('open', () => {
        // This should throw because _send is not set yet
        try {
          channel.send('test data');
        } catch (err) {
          errorThrown = true;
          assert.strictEqual(err.message, 'Data channel not connected to network transport');
        }
        
        // Verify error was thrown
        assert.ok(errorThrown, 'Expected error to be thrown when _send not set');
        resolve();
      });

      // Wrong order: open BEFORE setting _send
      channel._setStateToOpen();
      channel._send = async (data) => Promise.resolve();
    });
  });
});
