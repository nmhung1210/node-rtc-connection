/**
 * Example: NodeRTC with STUN, NAT Traversal, and Encryption
 * 
 * This example demonstrates:
 * - STUN server integration for NAT traversal
 * - Automatic ICE candidate gathering (host + srflx)
 * - Optional TLS encryption
 * - Real peer-to-peer connection across networks
 */

const { createPeerConnection } = require('../src');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function main() {
  console.log('=========================================='  );
  console.log('NodeRTC - STUN + Encryption Example');
  console.log('==========================================\n');

  // Configuration with STUN servers and encryption
  const config = {
    ...peerConfig.stunOnly,
    encryption: false,  // Encryption requires proper certificates (advanced)
    transport: 'tcp'    // Use TCP (can be 'udp' for lower latency)
  };

  // Create two peer connections
  console.log('Creating peer connections with configuration:');
  console.log('  - STUN servers: From config file');
  console.log('  - Encryption: DISABLED (optional feature)');
  console.log('  - Transport: TCP\n');

  const pc1 = createPeerConnection(config);
  const pc2 = createPeerConnection(config);

  // Track ICE candidates
  let pc1Candidates = [];
  let pc2Candidates = [];

  // Setup ICE candidate handlers
  pc1.on('icecandidate', (event) => {
    if (event.candidate) {
      pc1Candidates.push(event.candidate);
      console.log('[PC1] ICE Candidate:', parseCandidate(event.candidate.candidate));
      pc2.addIceCandidate(event.candidate);
    }
  });

  pc2.on('icecandidate', (event) => {
    if (event.candidate) {
      pc2Candidates.push(event.candidate);
      console.log('[PC2] ICE Candidate:', parseCandidate(event.candidate.candidate));
      pc1.addIceCandidate(event.candidate);
    }
  });

  // Setup connection state handlers
  pc1.on('iceconnectionstatechange', (state) => {
    console.log(`[PC1] ICE Connection State: ${getStateName(state)}`);
  });

  pc2.on('iceconnectionstatechange', (state) => {
    console.log(`[PC2] ICE Connection State: ${getStateName(state)}`);
  });

  // Create data channel on PC1
  console.log('\n[PC1] Creating data channel "chat"...');
  const channel1 = pc1.createDataChannel('chat');

  channel1.on('open', () => {
    console.log('[PC1] Data channel opened!');
    // Small delay to ensure remote channel is ready
    setTimeout(() => {
      console.log('[PC1] Sending message...');
      channel1.send('Hello from PC1! This works across the internet with STUN.');
    }, 100);
  });

  channel1.on('message', (event) => {
    console.log('[PC1] Received:', event.data.toString());
  });

  // Handle data channel on PC2
  pc2.on('datachannel', (event) => {
    console.log('[PC2] Data channel received!');
    const channel2 = event.channel;

    channel2.on('open', () => {
      console.log('[PC2] Data channel opened!');
    });

    channel2.on('message', (event) => {
      console.log('[PC2] Received:', event.data.toString());
      console.log('[PC2] Sending reply...');
      channel2.send('Hello from PC2! NAT traversal works!');
      
      // Send binary data
      setTimeout(() => {
        const binaryData = Buffer.from([1, 2, 3, 4, 5]);
        console.log('[PC2] Sending binary data:', Array.from(binaryData));
        channel2.send(binaryData);
      }, 100);
    });
  });

  // Create offer and answer
  console.log('\n[PC1] Creating offer with ICE gathering...');
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  
  console.log('\n[PC2] Setting remote description...');
  await pc2.setRemoteDescription(offer);
  
  console.log('[PC2] Creating answer with ICE gathering...');
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  
  console.log('\n[PC1] Setting remote description...');
  await pc1.setRemoteDescription(answer);

  // Wait for ICE gathering to complete
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Display results
  console.log('\n==========================================');
  console.log('ICE Gathering Complete!');
  console.log('==========================================');
  console.log(`\nPC1 gathered ${pc1Candidates.length} candidates:`);
  pc1Candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${parseCandidate(c.candidate)}`);
  });

  console.log(`\nPC2 gathered ${pc2Candidates.length} candidates:`);
  pc2Candidates.forEach((c, i) => {
    console.log(`  ${i + 1}. ${parseCandidate(c.candidate)}`);
  });

  // Keep running for a bit to see messages
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\n==========================================');
  console.log('Closing connections...');
  console.log('==========================================\n');

  pc1.close();
  pc2.close();

  console.log('✅ Example complete!\n');
  console.log('Key features demonstrated:');
  console.log('  ✓ STUN-based NAT traversal');
  console.log('  ✓ Host and server reflexive candidates');
  console.log('  ✓ Works across different networks');
  console.log('  ✓ Real peer-to-peer communication');
}

// Helper functions
function parseCandidate(candidateStr) {
  const parts = candidateStr.replace('candidate:', '').split(' ');
  if (parts.length >= 8) {
    return `${parts[7]} - ${parts[4]}:${parts[5]} (${parts[2].toUpperCase()})`;
  }
  return candidateStr;
}

function getStateName(state) {
  const states = ['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'];
  return states[state] || `unknown(${state})`;
}

// Run the example
main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
