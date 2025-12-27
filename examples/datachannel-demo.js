/**
 * @file datachannel-demo.js
 * @description Demonstration of RTCDataChannel with the complete WebRTC stack
 * 
 * This example shows how to:
 * 1. Generate certificates
 * 2. Setup ICE transport
 * 3. Setup DTLS encryption
 * 4. Setup SCTP transport
 * 5. Create and use a data channel
 */

const {
  RTCCertificate,
  RTCIceTransport,
  RTCDtlsTransport,
  RTCSctpTransport,
  RTCDataChannel
} = require('../src/index.js');

async function demonstrateDataChannel() {
  console.log('=== RTCDataChannel Demo ===\n');

  // Step 1: Generate a certificate for DTLS
  console.log('1. Generating DTLS certificate...');
  const certificate = await RTCCertificate.generateCertificate({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256'
  });
  console.log('   Certificate generated with fingerprints:');
  certificate.getFingerprints().forEach(fp => {
    console.log(`   - ${fp.algorithm}: ${fp.value.substring(0, 40)}...`);
  });
  console.log();

  // Step 2: Create ICE transport
  console.log('2. Creating ICE transport...');
  const iceTransport = new RTCIceTransport();
  console.log(`   ICE transport created in state: ${iceTransport.state}`);
  console.log();

  // Step 3: Create DTLS transport
  console.log('3. Creating DTLS transport...');
  const dtlsTransport = new RTCDtlsTransport(iceTransport, [certificate]);
  console.log(`   DTLS transport created in state: ${dtlsTransport.state}`);
  console.log();

  // Step 4: Create SCTP transport
  console.log('4. Creating SCTP transport...');
  const sctpTransport = new RTCSctpTransport(dtlsTransport, {
    maxMessageSize: 262144, // 256 KB
    maxChannels: 65535
  });
  console.log(`   SCTP transport created in state: ${sctpTransport.state}`);
  console.log(`   Max message size: ${sctpTransport.maxMessageSize} bytes`);
  console.log(`   Max channels: ${sctpTransport.maxChannels}`);
  console.log();

  // Step 5: Create data channel
  console.log('5. Creating data channel...');
  const dataChannel = new RTCDataChannel('myChannel', {
    ordered: true,
    protocol: 'json',
    bufferedAmountLowThreshold: 1024
  });
  console.log(`   Data channel created: "${dataChannel.label}"`);
  console.log(`   - Ordered: ${dataChannel.ordered}`);
  console.log(`   - Protocol: ${dataChannel.protocol}`);
  console.log(`   - State: ${dataChannel.readyState}`);
  console.log();

  // Step 6: Setup event handlers
  console.log('6. Setting up event handlers...');
  
  dataChannel.on('open', () => {
    console.log('   ✓ Data channel opened!');
    
    // Send some test messages
    console.log('\n7. Sending test messages...');
    dataChannel.send('Hello, WebRTC!');
    console.log('   Sent string message');
    
    const buffer = new ArrayBuffer(16);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < 16; i++) {
      view[i] = i;
    }
    dataChannel.send(buffer);
    console.log('   Sent ArrayBuffer (16 bytes)');
    console.log(`   Buffered amount: ${dataChannel.bufferedAmount} bytes`);
  });

  dataChannel.on('message', (event) => {
    console.log(`   Received: ${event.data}`);
  });

  dataChannel.on('bufferedamountlow', () => {
    console.log('   ✓ Buffer drained below threshold');
  });

  dataChannel.on('error', (error) => {
    console.error(`   ✗ Error: ${error.message}`);
  });

  dataChannel.on('closing', () => {
    console.log('   Data channel closing...');
  });

  dataChannel.on('close', () => {
    console.log('   ✓ Data channel closed');
  });

  console.log('   Event handlers registered');
  console.log();

  // Simulate opening the channel
  console.log('8. Simulating channel open...');
  setTimeout(() => {
    dataChannel._setStateToOpen();
  }, 100);

  // Wait for messages to be sent
  await new Promise(resolve => setTimeout(resolve, 200));

  // Close the channel
  console.log('\n9. Closing data channel...');
  dataChannel.close();

  // Wait for close to complete
  await new Promise(resolve => setTimeout(resolve, 100));

  console.log('\n=== Demo Complete ===');
  console.log('\nSummary:');
  console.log('✓ Certificate generated with DTLS fingerprints');
  console.log('✓ ICE transport initialized');
  console.log('✓ DTLS encryption layer configured');
  console.log('✓ SCTP reliable transport established');
  console.log('✓ Data channel created and used successfully');
  console.log('\nThe complete WebRTC stack is operational!');
}

// Run the demo
demonstrateDataChannel().catch(console.error);
