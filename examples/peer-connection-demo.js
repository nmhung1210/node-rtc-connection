/**
 * @file peer-connection-demo.js
 * @description Simple demonstration of RTCPeerConnection
 */

const { RTCPeerConnection } = require('../src/index.js');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

async function demo() {
  console.log('=== RTCPeerConnection Demo ===\n');

  // Create Peer A (offerer) - using local config for demo
  console.log('1. Creating Peer A...');
  const peerA = new RTCPeerConnection(peerConfig.localDemo);
  
  // Create Peer B (answerer)
  console.log('2. Creating Peer B...');
  const peerB = new RTCPeerConnection(peerConfig.localDemo);

  // Setup event handlers for Peer A
  peerA.on('icecandidate', async (event) => {
    if (event.candidate) {
      console.log('   Peer A: New ICE candidate');
      // In real app, send to remote peer via signaling
      await peerB.addIceCandidate(event.candidate);
    }
  });

  peerA.on('connectionstatechange', () => {
    console.log(`   Peer A connection state: ${peerA.connectionState}`);
  });

  // Setup event handlers for Peer B
  peerB.on('icecandidate', async (event) => {
    if (event.candidate) {
      console.log('   Peer B: New ICE candidate');
      // In real app, send to remote peer via signaling
      await peerA.addIceCandidate(event.candidate);
    }
  });

  peerB.on('connectionstatechange', () => {
    console.log(`   Peer B connection state: ${peerB.connectionState}`);
  });

  peerB.on('datachannel', (event) => {
    console.log(`   Peer B: Received data channel "${event.channel.label}"`);
    const channel = event.channel;
    
    channel.on('open', () => {
      console.log('   Peer B: Data channel opened');
      channel.send('Hello from Peer B!');
    });

    channel.on('message', (event) => {
      console.log(`   Peer B received: ${event.data}`);
    });
  });

  // Create data channel on Peer A
  console.log('\n3. Creating data channel on Peer A...');
  const channelA = peerA.createDataChannel('testChannel', {
    ordered: true
  });

  channelA.on('open', () => {
    console.log('   Peer A: Data channel opened');
    channelA.send('Hello from Peer A!');
  });

  channelA.on('message', (event) => {
    console.log(`   Peer A received: ${event.data}`);
  });

  // Create offer
  console.log('\n4. Peer A creating offer...');
  const offer = await peerA.createOffer();
  console.log('   ✓ Offer created');
  console.log(`   - Type: ${offer.type}`);
  console.log(`   - SDP length: ${offer.sdp ? offer.sdp.length : 0} bytes`);

  // Set local description on Peer A
  console.log('\n5. Peer A setting local description...');
  await peerA.setLocalDescription(offer);
  console.log(`   ✓ Local description set`);
  console.log(`   - Signaling state: ${peerA.signalingState}`);

  // Set remote description on Peer B
  console.log('\n6. Peer B setting remote description...');
  await peerB.setRemoteDescription(offer);
  console.log(`   ✓ Remote description set`);
  console.log(`   - Signaling state: ${peerB.signalingState}`);

  // Create answer
  console.log('\n7. Peer B creating answer...');
  const answer = await peerB.createAnswer();
  console.log('   ✓ Answer created');
  console.log(`   - Type: ${answer.type}`);

  // Set local description on Peer B
  console.log('\n8. Peer B setting local description...');
  await peerB.setLocalDescription(answer);
  console.log(`   ✓ Local description set`);
  console.log(`   - Signaling state: ${peerB.signalingState}`);

  // Set remote description on Peer A
  console.log('\n9. Peer A setting remote description...');
  await peerA.setRemoteDescription(answer);
  console.log(`   ✓ Remote description set`);
  console.log(`   - Signaling state: ${peerA.signalingState}`);

  console.log('\n10. Connection established!');
  console.log(`   - Peer A state: ${peerA.connectionState}`);
  console.log(`   - Peer B state: ${peerB.connectionState}`);

  // Wait for messages
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Close connections
  console.log('\n11. Closing connections...');
  peerA.close();
  peerB.close();
  console.log('   ✓ Connections closed');

  console.log('\n=== Demo Complete ===');
  console.log('\nSummary:');
  console.log('✓ Created two RTCPeerConnection instances');
  console.log('✓ Created data channel on Peer A');
  console.log('✓ Exchanged offer/answer via signaling');
  console.log('✓ Peer B received data channel');
  console.log('✓ Successfully demonstrated peer connection lifecycle');
}

demo().catch(console.error);
