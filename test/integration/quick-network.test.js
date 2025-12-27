/**
 * @file quick-network.test.js
 * @description Fast integration test for real networking
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createConnectedPeers, closePeers } = require('../helpers/peer-connection-helper.js');

describe('Real Network Integration', () => {
  it('should establish real TCP connection and exchange messages', async () => {
    // Create connected peers
    const { pc1, pc2, channel1, channel2 } = await createConnectedPeers('integration');
    
    try {
      // Verify channels are open
      assert.strictEqual(channel1.readyState, 'open');
      assert.strictEqual(channel2.readyState, 'open');
      
      // Test bidirectional messaging
      const messages = [];
      
      channel1.on('message', (event) => {
        messages.push(`ch1: ${event.data}`);
      });
      
      channel2.on('message', (event) => {
        messages.push(`ch2: ${event.data}`);
      });
      
      // Send messages
      channel1.send('Hello from channel 1');
      channel2.send('Hello from channel 2');
      
      // Wait for messages to arrive
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Verify messages were received
      assert.ok(messages.includes('ch1: Hello from channel 2'));
      assert.ok(messages.includes('ch2: Hello from channel 1'));
      
      // Test channel close
      channel1.close();
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.strictEqual(channel1.readyState, 'closed');
      
    } finally {
      closePeers(pc1, pc2);
    }
  });
});
