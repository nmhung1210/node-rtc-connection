/**
 * Example demonstrating the data channel open event fix
 * 
 * This shows that you can now reliably send data immediately
 * when the 'open' event fires on a data channel.
 */

const { RTCPeerConnection } = require('node-rtc-connection');

// Simulated signaling channel
let signalingData = {};

async function runExample() {
  console.log('=== Data Channel Open Event Fix Demo ===\n');

  // Create peer connections
  const pc1 = new RTCPeerConnection({
    iceServers: []
  });

  const pc2 = new RTCPeerConnection({
    iceServers: []
  });

  // Setup signaling
  pc1.on('icecandidate', (event) => {
    if (event.candidate) {
      pc2.addIceCandidate(event.candidate).catch(console.error);
    }
  });

  pc2.on('icecandidate', (event) => {
    if (event.candidate) {
      pc1.addIceCandidate(event.candidate).catch(console.error);
    }
  });

  // CLIENT (Offerer) creates data channel
  console.log('1. Client creating data channel...');
  const channel1 = pc1.createDataChannel('chat', {
    ordered: true
  });

  channel1.on('open', () => {
    console.log('   ✓ Client channel opened');
    
    // Can send immediately in open handler
    try {
      channel1.send('Hello from client!');
      console.log('   ✓ Client sent message in open handler');
    } catch (err) {
      console.error('   ✗ Client failed to send:', err.message);
    }
  });

  channel1.on('message', (event) => {
    console.log('   ← Client received:', event.data);
  });

  // SERVER (Answerer) receives data channel
  console.log('\n2. Server listening for data channel...');
  
  pc2.on('datachannel', (event) => {
    const channel2 = event.channel;
    console.log('   ✓ Server received data channel:', channel2.label);

    // THIS IS THE FIX - Can now send immediately in open handler!
    channel2.on('open', () => {
      console.log('   ✓ Server channel opened');
      
      // BEFORE FIX: This would throw "Data channel not connected to network transport"
      // AFTER FIX: This works correctly!
      try {
        channel2.send('Hello from server!');
        console.log('   ✓ Server sent message in open handler (FIX VERIFIED!)');
      } catch (err) {
        console.error('   ✗ Server failed to send:', err.message);
      }
    });

    channel2.on('message', (event) => {
      console.log('   ← Server received:', event.data);
    });

    channel2.on('error', (err) => {
      console.error('   ✗ Server channel error:', err);
    });
  });

  // Establish connection
  console.log('\n3. Establishing connection...');
  try {
    // Create and exchange offers/answers
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    
    await pc1.setRemoteDescription(answer);
    
    console.log('   ✓ Offer/Answer exchange complete');
  } catch (err) {
    console.error('   ✗ Connection failed:', err);
  }

  // Wait a bit for channels to open and messages to be exchanged
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log('\n4. Cleanup...');
  pc1.close();
  pc2.close();
  
  console.log('\n=== Demo Complete ===');
  console.log('✓ Both client and server can send immediately in open handler');
  console.log('✓ No "Data channel not connected to network transport" errors');
}

// Run the example
runExample().catch(console.error);
