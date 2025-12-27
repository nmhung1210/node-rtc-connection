/**
 * Real Networking Example
 * Demonstrates actual peer-to-peer communication using Node.js net package
 */

const { createPeerConnection } = require('../src');

console.log('=== NodeRTC Real Networking Example ===\n');
console.log('Using real TCP connections for DataChannel communication\n');

// Create two peer connections
const pc1 = createPeerConnection({
  iceServers: []  // No STUN server needed for local networking
});

const pc2 = createPeerConnection({
  iceServers: []
});

console.log('✓ Created two peer connections\n');

let channel1, channel2;

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

// Handle ICE connection state
pc1.on('iceconnectionstatechange', () => {
  console.log(`PC1: ICE connection state: ${pc1.iceConnectionState}`);
  if (pc1.iceConnectionState === 'connected') {
    console.log('🎉 PC1 connected!\n');
  }
});

pc2.on('iceconnectionstatechange', () => {
  console.log(`PC2: ICE connection state: ${pc2.iceConnectionState}`);
  if (pc2.iceConnectionState === 'connected') {
    console.log('🎉 PC2 connected!\n');
  }
});

// Handle incoming data channel on peer 2
pc2.on('datachannel', (event) => {
  channel2 = event.channel;
  console.log(`\n📡 PC2: Remote data channel received: "${channel2.label}"`);
  console.log(`   Channel state: ${channel2.readyState}`);
  
  // Check if already open
  if (channel2.readyState === 'open') {
    console.log('✓ PC2: Data channel already open!');
  }
  
  channel2.on('open', () => {
    console.log('✓ PC2: Data channel opened!');
  });
  
  channel2.on('message', (event) => {
    const message = event.data.toString();
    console.log('📨 PC2 received:', message);
    
    // Send a reply
    setTimeout(() => {
      console.log('PC2: Sending reply...');
      try {
        channel2.send('Hello from Peer 2! Nice to meet you.');
        console.log('✓ Reply sent\n');
      } catch (err) {
        console.error('PC2 send error:', err.message);
      }
    }, 500);
  });
  
  channel2.on('close', () => {
    console.log('PC2: Data channel closed');
  });
  
  channel2.on('error', (error) => {
    console.error('PC2: Data channel error:', error);
  });
});

// Create data channel on peer 1 BEFORE signaling
console.log('Creating data channel on PC1...');
channel1 = pc1.createDataChannel('chat', {
  ordered: true
});

console.log(`✓ Data channel created: "${channel1.label}"\n`);

// Handle data channel events on peer 1
channel1.on('open', () => {
  console.log('✓ PC1: Data channel opened!\n');
  
  // Send first message
  setTimeout(() => {
    console.log('PC1: Sending first message...');
    try {
      channel1.send('Hello from Peer 1!');
      console.log('✓ Message sent\n');
    } catch (error) {
      console.error('PC1: Failed to send message:', error.message);
    }
  }, 500);
});

channel1.on('message', (event) => {
  console.log('📨 PC1 received:', event.data.toString());
  
  // Send another message
  setTimeout(() => {
    console.log('PC1: Sending another message...');
    try {
      channel1.send('Thanks! This is working great.');
    } catch (err) {
      console.error('PC1 send error:', err.message);
    }
  }, 500);
});

channel1.on('close', () => {
  console.log('PC1: Data channel closed');
});

channel1.on('error', (error) => {
  console.error('PC1: Data channel error:', error);
});

// Start the signaling process
async function startSignaling() {
  try {
    console.log('--- Starting Signaling ---\n');
    
    // PC1 creates offer
    console.log('PC1: Creating offer...');
    const offer = await pc1.createOffer();
    console.log('PC1: Offer created\n');
    
    // PC1 sets local description
    console.log('PC1: Setting local description...');
    await pc1.setLocalDescription(offer);
    console.log('PC1: Local description set\n');
    
    // Small delay for server to start
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // PC2 receives offer and sets remote description
    console.log('PC2: Setting remote description...');
    await pc2.setRemoteDescription(offer);
    console.log('PC2: Remote description set\n');
    
    // PC2 creates answer
    console.log('PC2: Creating answer...');
    const answer = await pc2.createAnswer();
    console.log('PC2: Answer created\n');
    
    // PC2 sets local description
    console.log('PC2: Setting local description...');
    await pc2.setLocalDescription(answer);
    console.log('PC2: Local description set\n');
    
    // Small delay for server to start
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // PC1 receives answer and sets remote description
    console.log('PC1: Setting remote description...');
    await pc1.setRemoteDescription(answer);
    console.log('PC1: Remote description set\n');
    
    console.log('✓ Signaling complete!\n');
    console.log('--- Waiting for connection ---\n');
    
  } catch (error) {
    console.error('❌ Signaling failed:', error.message);
    console.error(error.stack);
  }
}

// Start the example
startSignaling();

// Send more messages periodically
let messageCount = 0;
const messageInterval = setInterval(() => {
  if (channel1 && channel1.readyState === 'open') {
    messageCount++;
    if (messageCount <= 3) {
      console.log(`\nPC1: Sending periodic message #${messageCount}...`);
      try {
        channel1.send(`Periodic message ${messageCount} from PC1`);
      } catch (err) {
        console.error('Send error:', err.message);
      }
    }
  }
}, 3000);

// Cleanup after 12 seconds
setTimeout(() => {
  console.log('\n\n--- Cleaning up ---');
  clearInterval(messageInterval);
  
  if (channel1) channel1.close();
  pc1.close();
  pc2.close();
  
  console.log('✓ Connections closed');
  console.log('\n=== Example Complete ===');
  console.log('Successfully demonstrated real peer-to-peer communication!');
  
  setTimeout(() => process.exit(0), 500);
}, 12000);

// Handle process exit
process.on('SIGINT', () => {
  console.log('\n\nInterrupted, cleaning up...');
  clearInterval(messageInterval);
  if (channel1) channel1.close();
  if (pc1) pc1.close();
  if (pc2) pc2.close();
  process.exit(0);
});
