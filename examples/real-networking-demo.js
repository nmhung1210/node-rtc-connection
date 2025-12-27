/**
 * @file real-networking-demo.js
 * @description Demonstrates real TCP networking between two Node.js peers
 * 
 * This example creates two peer connections that communicate over actual
 * TCP sockets, demonstrating true peer-to-peer networking.
 */

const { RTCPeerConnection } = require('../dist/index.cjs');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

console.log('=== Real TCP Networking Demo ===\n');

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runDemo() {
  console.log('1. Creating two peer connections...');
  
  // Use local demo config (no STUN/TURN for local networking)
  const pc1 = new RTCPeerConnection(peerConfig.localDemo);
  const pc2 = new RTCPeerConnection(peerConfig.localDemo);

  console.log('   ✓ Peer 1 (Offerer) created');
  console.log('   ✓ Peer 2 (Answerer) created\n');

  // Track ICE candidates
  const pc1Candidates = [];
  const pc2Candidates = [];

  pc1.on('icecandidate', (event) => {
    if (event.candidate) {
      pc1Candidates.push(event.candidate);
      console.log('   PC1 ICE candidate:', event.candidate.candidate?.substring(0, 50) + '...');
    }
  });

  pc2.on('icecandidate', (event) => {
    if (event.candidate) {
      pc2Candidates.push(event.candidate);
      console.log('   PC2 ICE candidate:', event.candidate.candidate?.substring(0, 50) + '...');
    }
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
      channel.send('Hello from Peer 2! Nice to meet you.');
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
    channel.send('Hello from Peer 1!');
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
  console.log(`   Offer SDP (first 200 chars):\n   ${offer.sdp.substring(0, 200)}...\n`);

  // Set local description on PC1
  console.log('   PC1: Setting local description...');
  await pc1.setLocalDescription(offer);
  console.log('   ✓ Local description set\n');

  // Give ICE gathering a moment
  await delay(500);

  // Set remote description on PC2
  console.log('   PC2: Setting remote description...');
  await pc2.setRemoteDescription(offer);
  console.log('   ✓ Remote description set');

  // Create answer
  console.log('   PC2: Creating answer...');
  const answer = await pc2.createAnswer();
  console.log('   ✓ Answer created\n');

  // Set local description on PC2
  console.log('   PC2: Setting local description...');
  await pc2.setLocalDescription(answer);
  console.log('   ✓ Local description set');

  // Give ICE gathering a moment
  await delay(500);

  // Set remote description on PC1
  console.log('   PC1: Setting remote description...');
  await pc2.setRemoteDescription(answer);
  console.log('   ✓ Remote description set\n');

  console.log('4. Waiting for connection establishment...\n');

  // Wait for message exchange (with timeout)
  let waitTime = 0;
  const maxWait = 10000; // 10 seconds
  while (!messageReceived && waitTime < maxWait) {
    await delay(100);
    waitTime += 100;
  }

  if (messageReceived) {
    console.log('=== Success! ===');
    console.log('✓ TCP connection established');
    console.log('✓ Data channels opened');
    console.log('✓ Messages exchanged over real network sockets');
    console.log('✓ Bidirectional communication working\n');
  } else {
    console.log('⚠️  Message exchange timeout\n');
  }

  console.log('5. Cleaning up...');
  
  // Wait a bit before closing
  await delay(1000);
  
  pc1.close();
  pc2.close();
  
  console.log('   ✓ Connections closed\n');

  console.log('=== Demo Complete ===\n');
  
  console.log('What This Demonstrated:');
  console.log('• Real TCP socket communication between peers');
  console.log('• Actual network connection establishment');
  console.log('• TCP server listening on random port (offerer)');
  console.log('• TCP client connecting to server (answerer)');
  console.log('• Message framing with length prefixes');
  console.log('• Bidirectional data channel messaging');
  console.log('• Complete WebRTC-style signaling flow\n');

  console.log('Network Details:');
  console.log('• Transport: TCP (net module)');
  console.log('• Message Format: [4-byte length][JSON payload]');
  console.log('• Connection Mode: Client-Server (WebRTC-compatible)');
  console.log('• Local Networking: Works on same machine or LAN');
}

// Run the demo
runDemo().catch(error => {
  console.error('\nDemo error:', error);
  process.exit(1);
});
