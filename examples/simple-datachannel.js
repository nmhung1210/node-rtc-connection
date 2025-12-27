/**
 * Simple DataChannel Example
 * Demonstrates basic usage of the NodeRTC DataChannel-only implementation
 */

const { createPeerConnection } = require('../src');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('=== NodeRTC DataChannel Example ===\n');

// Create two peer connections (simulating two peers)
const pc1 = createPeerConnection(peerConfig.stunOnly);
const pc2 = createPeerConnection(peerConfig.stunOnly);

console.log('✓ Created two peer connections\n');

// Setup ICE candidate exchange
pc1.on('icecandidate', (event) => {
  if (event.candidate) {
    console.log('PC1: ICE candidate generated');
    pc2.addIceCandidate(event.candidate)
      .catch(err => console.error('PC2: Failed to add ICE candidate:', err));
  } else {
    console.log('PC1: ICE gathering complete');
  }
});

pc2.on('icecandidate', (event) => {
  if (event.candidate) {
    console.log('PC2: ICE candidate generated');
    pc1.addIceCandidate(event.candidate)
      .catch(err => console.error('PC1: Failed to add ICE candidate:', err));
  } else {
    console.log('PC2: ICE gathering complete');
  }
});

// Handle signaling state changes
pc1.on('signalingstatechange', () => {
  console.log(`PC1: Signaling state changed to: ${pc1.signalingState}`);
});

pc2.on('signalingstatechange', () => {
  console.log(`PC2: Signaling state changed to: ${pc2.signalingState}`);
});

// Handle ICE connection state changes
pc1.on('iceconnectionstatechange', () => {
  console.log(`PC1: ICE connection state: ${pc1.iceConnectionState}`);
});

pc2.on('iceconnectionstatechange', () => {
  console.log(`PC2: ICE connection state: ${pc2.iceConnectionState}`);
});

// Create data channel on peer 1
console.log('Creating data channel on PC1...');
const channel1 = pc1.createDataChannel('chat', {
  ordered: true,
  maxRetransmits: 3
});

console.log(`✓ Data channel created: "${channel1.label}"\n`);

// Handle data channel events on peer 1
channel1.on('open', () => {
  console.log('\n🎉 PC1: Data channel opened!');
  console.log('PC1: Sending message to PC2...');
  
  try {
    channel1.send('Hello from Peer 1!');
    console.log('PC1: Message sent\n');
  } catch (error) {
    console.error('PC1: Failed to send message:', error.message);
  }
});

channel1.on('message', (event) => {
  console.log('📨 PC1: Received message:', event.data);
  
  // Send a reply
  setTimeout(() => {
    console.log('PC1: Sending reply...');
    channel1.send('Thanks for your message, Peer 2!');
  }, 1000);
});

channel1.on('close', () => {
  console.log('PC1: Data channel closed');
});

channel1.on('error', (error) => {
  console.error('PC1: Data channel error:', error);
});

// Handle incoming data channel on peer 2
pc2.on('datachannel', (event) => {
  const channel2 = event.channel;
  console.log(`\n🎉 PC2: Remote data channel received: "${channel2.label}"`);
  
  channel2.on('open', () => {
    console.log('PC2: Data channel opened!');
  });
  
  channel2.on('message', (event) => {
    console.log('📨 PC2: Received message:', event.data);
    
    // Send a reply
    setTimeout(() => {
      console.log('PC2: Sending reply...');
      channel2.send('Hello from Peer 2!');
    }, 500);
  });
  
  channel2.on('close', () => {
    console.log('PC2: Data channel closed');
  });
  
  channel2.on('error', (error) => {
    console.error('PC2: Data channel error:', error);
  });
});

// Start the signaling process
async function startSignaling() {
  try {
    console.log('\n--- Starting Signaling Process ---\n');
    
    // PC1 creates offer
    console.log('PC1: Creating offer...');
    const offer = await pc1.createOffer();
    console.log('PC1: Offer created');
    
    // PC1 sets local description
    console.log('PC1: Setting local description...');
    await pc1.setLocalDescription(offer);
    console.log('PC1: Local description set\n');
    
    // PC2 receives offer and sets remote description
    console.log('PC2: Receiving offer...');
    await pc2.setRemoteDescription(offer);
    console.log('PC2: Remote description set');
    
    // PC2 creates answer
    console.log('PC2: Creating answer...');
    const answer = await pc2.createAnswer();
    console.log('PC2: Answer created');
    
    // PC2 sets local description
    console.log('PC2: Setting local description...');
    await pc2.setLocalDescription(answer);
    console.log('PC2: Local description set\n');
    
    // PC1 receives answer and sets remote description
    console.log('PC1: Receiving answer...');
    await pc1.setRemoteDescription(answer);
    console.log('PC1: Remote description set');
    
    console.log('\n✓ Signaling complete!\n');
    console.log('--- Waiting for connection establishment ---\n');
    
  } catch (error) {
    console.error('❌ Signaling failed:', error.message);
    console.error(error);
  }
}

// Start the example
startSignaling();

// Display channel properties after a moment
setTimeout(() => {
  console.log('\n--- Data Channel Properties ---');
  console.log('Label:', channel1.label);
  console.log('Ordered:', channel1.ordered);
  console.log('Protocol:', channel1.protocol);
  console.log('ID:', channel1.id);
  console.log('Ready State:', channel1.readyState);
  console.log('Buffered Amount:', channel1.bufferedAmount);
  console.log('Binary Type:', channel1.binaryType);
}, 2000);

// Cleanup after 5 seconds
setTimeout(() => {
  console.log('\n--- Cleaning up ---');
  channel1.close();
  pc1.close();
  pc2.close();
  console.log('✓ Connections closed');
  console.log('\nExample complete!');
}, 5000);

// Handle process exit
process.on('SIGINT', () => {
  console.log('\n\nInterrupted, cleaning up...');
  if (channel1) channel1.close();
  if (pc1) pc1.close();
  if (pc2) pc2.close();
  process.exit(0);
});
