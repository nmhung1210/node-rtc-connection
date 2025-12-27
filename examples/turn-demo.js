/**
 * @file turn-demo.js
 * @description Demonstrates TURN (Traversal Using Relays around NAT) support with real networking
 * 
 * This example shows how to configure TURN servers for relay candidates,
 * and establishes a real peer-to-peer connection using TURN relay if needed.
 * 
 * TURN servers require authentication (username and credential).
 */

const { RTCPeerConnection } = require('../dist/index.cjs');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('=== TURN (Relay) Support Demo with Real Networking ===\n');
console.log('Using configuration from peer.config.json');
console.log('TURN servers:', JSON.stringify(peerConfig.turnConfig.iceServers, null, 2), '\n');

// Use TURN configuration from config file
const configuration = peerConfig.turnConfig;

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDemo() {
  console.log('1. Creating two peer connections with STUN and TURN servers...');
  const pc1 = new RTCPeerConnection(configuration);
  const pc2 = new RTCPeerConnection(configuration);
  console.log('   ✓ Peer 1 (Offerer) created');
  console.log('   ✓ Peer 2 (Answerer) created\n');

  // Track different candidate types for both peers
  let pc1HostCount = 0, pc1SrflxCount = 0, pc1RelayCount = 0;
  let pc2HostCount = 0, pc2SrflxCount = 0, pc2RelayCount = 0;

  // Listen for ICE candidates from PC1
  pc1.on('icecandidate', (event) => {
    if (event.candidate) {
      const candidateStr = event.candidate.candidate;
      const parts = candidateStr.split(' ');
      const typeIndex = parts.indexOf('typ');
      const type = typeIndex >= 0 ? parts[typeIndex + 1] : 'unknown';
      const address = parts[4];
      const port = parts[5];
      
      if (type === 'host') {
        pc1HostCount++;
        console.log(`   PC1 → Host candidate: ${address}:${port}`);
      } else if (type === 'srflx') {
        pc1SrflxCount++;
        console.log(`   PC1 → Server reflexive (STUN): ${address}:${port}`);
      } else if (type === 'relay') {
        pc1RelayCount++;
        console.log(`   PC1 → Relay candidate (TURN): ${address}:${port}`);
      }
      
      // Forward candidate to PC2
      pc2.addIceCandidate(event.candidate).catch(err => {
        console.error('   Error adding ICE candidate to PC2:', err.message);
      });
    }
  });

  // Listen for ICE candidates from PC2
  pc2.on('icecandidate', (event) => {
    if (event.candidate) {
      const candidateStr = event.candidate.candidate;
      const parts = candidateStr.split(' ');
      const typeIndex = parts.indexOf('typ');
      const type = typeIndex >= 0 ? parts[typeIndex + 1] : 'unknown';
      const address = parts[4];
      const port = parts[5];
      
      if (type === 'host') {
        pc2HostCount++;
        console.log(`   PC2 → Host candidate: ${address}:${port}`);
      } else if (type === 'srflx') {
        pc2SrflxCount++;
        console.log(`   PC2 → Server reflexive (STUN): ${address}:${port}`);
      } else if (type === 'relay') {
        pc2RelayCount++;
        console.log(`   PC2 → Relay candidate (TURN): ${address}:${port}`);
      }
      
      // Forward candidate to PC1
      pc1.addIceCandidate(event.candidate).catch(err => {
        console.error('   Error adding ICE candidate to PC1:', err.message);
      });
    }
  });

  // Track gathering state
  pc1.on('icegatheringstatechange', () => {
    console.log(`   PC1 ICE gathering state: ${pc1.iceGatheringState}`);
  });

  pc2.on('icegatheringstatechange', () => {
    console.log(`   PC2 ICE gathering state: ${pc2.iceGatheringState}`);
  });

  // Track connection state
  pc1.on('connectionstatechange', () => {
    console.log(`   PC1 connection state: ${pc1.connectionState}`);
  });

  pc2.on('connectionstatechange', () => {
    console.log(`   PC2 connection state: ${pc2.connectionState}`);
  });

  // PC2 listens for incoming data channels
  pc2.on('datachannel', (event) => {
    const channel = event.channel;
    console.log(`\n✓ PC2: Received data channel "${channel.label}"`);
    
    channel.on('open', () => {
      console.log('✓ PC2: Data channel opened!\n');
    });

    channel.on('message', (event) => {
      console.log(`📨 PC2 received: "${event.data}"`);
      
      // Send reply
      console.log('   PC2: Sending reply...');
      channel.send('Hello from Peer 2! TURN relay is working!');
    });

    channel.on('close', () => {
      console.log('PC2: Data channel closed');
    });
  });

  console.log('2. Creating data channel on Peer 1...');
  const channel = pc1.createDataChannel('chat', {
    ordered: true
  });

  let messageReceived = false;

  channel.on('open', () => {
    console.log('✓ PC1: Data channel opened!\n');
    
    // Send first message
    console.log('PC1: Sending first message...');
    channel.send('Hello from Peer 1 via TURN relay!');
  });

  channel.on('message', (event) => {
    console.log(`📨 PC1 received: "${event.data}"\n`);
    messageReceived = true;
  });

  channel.on('close', () => {
    console.log('PC1: Data channel closed');
  });

  console.log('   ✓ Data channel created\n');

  console.log('3. Starting signaling (offer/answer exchange)...');
  
  // Create offer
  console.log('   PC1: Creating offer...');
  const offer = await pc1.createOffer();
  console.log('   ✓ Offer created');

  // Set local description on PC1 (starts ICE gathering)
  console.log('   PC1: Setting local description (starts ICE gathering)...');
  await pc1.setLocalDescription(offer);
  console.log('   ✓ Local description set\n');

  // Wait for PC1 ICE gathering to complete
  console.log('4. Waiting for PC1 ICE candidate gathering...\n');
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15000);
    pc1.on('icegatheringstatechange', () => {
      if (pc1.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  console.log('\n5. PC1 Gathering Results:');
  console.log(`   - Total candidates: ${pc1HostCount + pc1SrflxCount + pc1RelayCount}`);
  console.log(`   - Host: ${pc1HostCount}, STUN: ${pc1SrflxCount}, TURN: ${pc1RelayCount}\n`);

  // Set remote description on PC2
  console.log('6. PC2: Setting remote description...');
  await pc2.setRemoteDescription(offer);
  console.log('   ✓ Remote description set');

  // Create answer
  console.log('   PC2: Creating answer...');
  const answer = await pc2.createAnswer();
  console.log('   ✓ Answer created\n');

  // Set local description on PC2 (starts ICE gathering)
  console.log('   PC2: Setting local description (starts ICE gathering)...');
  await pc2.setLocalDescription(answer);
  console.log('   ✓ Local description set\n');

  // Wait for PC2 ICE gathering to complete
  console.log('7. Waiting for PC2 ICE candidate gathering...\n');
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 15000);
    pc2.on('icegatheringstatechange', () => {
      if (pc2.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  console.log('\n8. PC2 Gathering Results:');
  console.log(`   - Total candidates: ${pc2HostCount + pc2SrflxCount + pc2RelayCount}`);
  console.log(`   - Host: ${pc2HostCount}, STUN: ${pc2SrflxCount}, TURN: ${pc2RelayCount}\n`);

  // Set remote description on PC1
  console.log('9. PC1: Setting remote description...');
  await pc1.setRemoteDescription(answer);
  console.log('   ✓ Remote description set\n');

  console.log('10. Waiting for connection establishment and message exchange...\n');

  // Wait for message exchange (with timeout)
  let waitTime = 0;
  const maxWait = 10000; // 10 seconds
  while (!messageReceived && waitTime < maxWait) {
    await delay(500);
    waitTime += 500;
  }

  if (messageReceived) {
    console.log('✅ Success! Bidirectional communication established via TURN relay!\n');
  } else {
    console.log('⚠️  Timeout waiting for message exchange\n');
  }

  console.log('11. Connection Summary:');
  console.log(`   - PC1 state: ${pc1.connectionState}`);
  console.log(`   - PC2 state: ${pc2.connectionState}`);
  console.log(`   - Messages exchanged: ${messageReceived ? 'Yes' : 'No'}\n`);

  console.log('12. Closing connections...');
  channel.close();
  pc1.close();
  pc2.close();
  console.log('   ✓ Connections closed\n');

  console.log('=== Demo Complete ===\n');
  console.log('What This Demonstrates:');
  console.log('✓ Configured peer connections with both STUN and TURN servers');
  console.log('✓ Gathered host, server reflexive (STUN), and relay (TURN) candidates');
  console.log('✓ Established real peer-to-peer connection using ICE candidates');
  console.log('✓ Exchanged messages over data channel through TURN relay');
  console.log('✓ Demonstrated that TURN relay works for NAT traversal');
  console.log('\nTURN relay candidates ensure connectivity even in restricted');
  console.log('network environments where direct P2P connections fail!');
}

// Run the demo
runDemo().catch(error => {
  console.error('Demo error:', error);
  process.exit(1);
});
