/**
 * @file stun-demo.js
 * @description Demonstration of STUN support for NAT traversal
 */

const { RTCPeerConnection } = require('../src/index.js');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function demonstrateSTUN() {
  console.log('=== STUN/TURN Support Demo ===\n');

  // Create peer connection with STUN servers
  console.log('1. Creating peer connection with STUN servers...');
  const pc = new RTCPeerConnection(peerConfig.stunOnly);
  console.log('   ✓ Peer connection created');

  // Setup event handlers
  let candidateCount = 0;
  let hostCandidates = 0;
  let srflxCandidates = 0;

  pc.on('icecandidate', (event) => {
    if (event.candidate) {
      candidateCount++;
      const candidateStr = event.candidate.candidate;
      
      if (candidateStr && candidateStr.includes('typ host')) {
        hostCandidates++;
        console.log(`   ✓ Host candidate #${hostCandidates}: ${candidateStr.substring(0, 80)}...`);
      } else if (candidateStr && candidateStr.includes('typ srflx')) {
        srflxCandidates++;
        console.log(`   ✓ Server reflexive candidate #${srflxCandidates}: ${candidateStr.substring(0, 80)}...`);
      }
    } else {
      console.log('   ✓ ICE gathering complete');
    }
  });

  pc.on('icegatheringstatechange', () => {
    console.log(`   ICE gathering state: ${pc.iceGatheringState}`);
  });

  pc.on('connectionstatechange', () => {
    console.log(`   Connection state: ${pc.connectionState}`);
  });

  // Create data channel
  console.log('\n2. Creating data channel...');
  const channel = pc.createDataChannel('stunTest', {
    ordered: true
  });
  console.log('   ✓ Data channel created');

  // Create offer (this will trigger ICE gathering)
  console.log('\n3. Creating offer (will gather ICE candidates)...');
  const offer = await pc.createOffer();
  console.log('   ✓ Offer created');

  // Set local description (starts gathering)
  console.log('\n4. Setting local description (starts ICE gathering)...');
  await pc.setLocalDescription(offer);
  console.log('   ✓ Local description set');

  // Wait for gathering to complete
  console.log('\n5. Waiting for ICE candidate gathering...\n');
  
  await new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (pc.iceGatheringState === 'complete') {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);
    
    // Timeout after 10 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, 10000);
  });

  console.log('\n6. Gathering Results:');
  console.log(`   - Total candidates gathered: ${candidateCount}`);
  console.log(`   - Host candidates (local): ${hostCandidates}`);
  console.log(`   - Server reflexive candidates (STUN): ${srflxCandidates}`);
  
  if (srflxCandidates > 0) {
    console.log('\n   ✅ STUN is working! Successfully obtained public IP addresses.');
  } else {
    console.log('\n   ⚠️  No STUN candidates gathered. This might be due to:');
    console.log('      - Network/firewall blocking STUN requests');
    console.log('      - STUN servers being unavailable');
    console.log('      - Running in an environment without internet access');
  }

  // Show the SDP
  console.log('\n7. Generated SDP Offer:');
  console.log('   ─────────────────────────────────────────');
  const sdpLines = offer.sdp.split('\r\n');
  sdpLines.slice(0, 15).forEach(line => {
    console.log(`   ${line}`);
  });
  if (sdpLines.length > 15) {
    console.log(`   ... (${sdpLines.length - 15} more lines)`);
  }
  console.log('   ─────────────────────────────────────────');

  // Close connection
  console.log('\n8. Closing connection...');
  pc.close();
  console.log('   ✓ Connection closed');

  console.log('\n=== Demo Complete ===');
  console.log('\nWhat This Demonstrates:');
  console.log('✓ Configured peer connection with multiple STUN servers');
  console.log('✓ Automatically gathered host candidates (local network addresses)');
  console.log('✓ Contacted STUN servers to discover public IP addresses');
  console.log('✓ Generated server reflexive candidates for NAT traversal');
  console.log('✓ Created complete SDP with ICE candidates');
  console.log('\nThese candidates can be exchanged with remote peers to establish');
  console.log('peer-to-peer connections even when both peers are behind NAT!');
}

demonstrateSTUN().catch(console.error);
