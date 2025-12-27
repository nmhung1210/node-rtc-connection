/**
 * Example: NodeRTC with TURN Server for Symmetric NAT
 * 
 * This example demonstrates:
 * - TURN relay for connections that can't use direct P2P
 * - Works behind symmetric NAT or firewalls
 * - Relay candidates with public TURN servers
 * - Complete ICE candidate gathering (host + srflx + relay)
 */

const { createPeerConnection } = require('../src');

async function main() {
  console.log('==========================================');
  console.log('NodeRTC - TURN Relay Example');
  console.log('==========================================\n');

  // Configuration with STUN and TURN servers
  const config = {
    iceServers: [
      // STUN for NAT discovery
      { urls: 'stun:stun.l.google.com:19302' },
      
      // TURN for relay (public servers)
      {
        urls: 'turn:numb.viagenie.ca:3478',
        username: 'webrtc@live.com',
        credential: 'muazkh'
      },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    encryption: false,
    transport: 'tcp'
  };

  console.log('Configuration:');
  console.log('  - STUN: Google STUN (NAT discovery)');
  console.log('  - TURN: Viagenie + Metered (relay)');
  console.log('  - Use case: Symmetric NAT / Firewalls\n');

  const pc1 = createPeerConnection(config);
  const pc2 = createPeerConnection(config);

  // Track all candidate types
  const pc1Candidates = { host: [], srflx: [], relay: [] };
  const pc2Candidates = { host: [], srflx: [], relay: [] };

  // Setup ICE candidate handlers
  pc1.on('icecandidate', (event) => {
    if (event.candidate) {
      const type = extractCandidateType(event.candidate.candidate);
      pc1Candidates[type]?.push(event.candidate);
      console.log(`[PC1] ICE Candidate (${type}):`, parseCandidateShort(event.candidate.candidate));
      pc2.addIceCandidate(event.candidate);
    }
  });

  pc2.on('icecandidate', (event) => {
    if (event.candidate) {
      const type = extractCandidateType(event.candidate.candidate);
      pc2Candidates[type]?.push(event.candidate);
      console.log(`[PC2] ICE Candidate (${type}):`, parseCandidateShort(event.candidate.candidate));
      pc1.addIceCandidate(event.candidate);
    }
  });

  // Connection state tracking
  pc1.on('iceconnectionstatechange', (state) => {
    console.log(`[PC1] ICE Connection State: ${getStateName(state)}`);
  });

  pc2.on('iceconnectionstatechange', (state) => {
    console.log(`[PC2] ICE Connection State: ${getStateName(state)}`);
  });

  // Create data channel
  console.log('[PC1] Creating data channel...\n');
  const channel1 = pc1.createDataChannel('relay-test');

  channel1.on('open', () => {
    console.log('\n[PC1] Data channel opened!');
    setTimeout(() => {
      console.log('[PC1] Sending message through relay...');
      channel1.send('Hello via TURN relay! This works even behind symmetric NAT.');
    }, 100);
  });

  channel1.on('message', (event) => {
    console.log('[PC1] Received:', event.data.toString());
  });

  // Handle data channel on PC2
  pc2.on('datachannel', (event) => {
    console.log('\n[PC2] Data channel received!');
    const channel2 = event.channel;

    channel2.on('open', () => {
      console.log('[PC2] Data channel opened!');
    });

    channel2.on('message', (event) => {
      console.log('[PC2] Received:', event.data.toString());
      console.log('[PC2] Sending reply...');
      channel2.send('Hello back! TURN relay working perfectly.');
    });
  });

  // Signaling
  console.log('[PC1] Creating offer...');
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  
  console.log('[PC2] Setting remote description...');
  await pc2.setRemoteDescription(offer);
  
  console.log('[PC2] Creating answer...');
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  
  console.log('[PC1] Setting remote description...\n');
  await pc1.setRemoteDescription(answer);

  // Wait for ICE gathering (including TURN)
  console.log('Gathering ICE candidates (this may take 5-10 seconds)...\n');
  await new Promise(resolve => setTimeout(resolve, 8000));

  // Display results
  console.log('\n==========================================');
  console.log('ICE Candidate Summary');
  console.log('==========================================\n');

  displayCandidateSummary('PC1', pc1Candidates);
  displayCandidateSummary('PC2', pc2Candidates);

  // Keep running
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\n==========================================');
  console.log('Closing connections...');
  console.log('==========================================\n');

  pc1.close();
  pc2.close();

  console.log('✅ TURN Example Complete!\n');
  console.log('Key Features Demonstrated:');
  console.log('  ✓ TURN relay allocation');
  console.log('  ✓ Multiple candidate types (host, srflx, relay)');
  console.log('  ✓ Works behind symmetric NAT');
  console.log('  ✓ Fallback connectivity via relay');
  console.log('  ✓ Public TURN server integration\n');
}

// Helper functions
function extractCandidateType(candidateStr) {
  if (candidateStr.includes('typ host')) return 'host';
  if (candidateStr.includes('typ srflx')) return 'srflx';
  if (candidateStr.includes('typ relay')) return 'relay';
  return 'unknown';
}

function parseCandidateShort(candidateStr) {
  const parts = candidateStr.replace('candidate:', '').split(' ');
  if (parts.length >= 8) {
    return `${parts[4]}:${parts[5]} (${parts[2].toUpperCase()})`;
  }
  return candidateStr;
}

function getStateName(state) {
  const states = ['new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'];
  return states[state] || `unknown(${state})`;
}

function displayCandidateSummary(peerName, candidates) {
  console.log(`${peerName} Candidates:`);
  console.log(`  Host:  ${candidates.host.length} candidate(s)`);
  candidates.host.slice(0, 2).forEach(c => {
    console.log(`    - ${parseCandidateShort(c.candidate)}`);
  });
  
  console.log(`  Srflx: ${candidates.srflx.length} candidate(s)`);
  candidates.srflx.forEach(c => {
    console.log(`    - ${parseCandidateShort(c.candidate)} (via STUN)`);
  });
  
  console.log(`  Relay: ${candidates.relay.length} candidate(s)`);
  candidates.relay.forEach(c => {
    console.log(`    - ${parseCandidateShort(c.candidate)} (via TURN)`);
  });
  
  console.log();
}

// Run the example
main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
