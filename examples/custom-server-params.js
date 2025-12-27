/**
 * Example demonstrating custom query parameters in ICE server URLs
 * This shows how to use query strings for transport selection and other parameters
 */

const { RTCPeerConnection } = require('../src/peerconnection/RTCPeerConnection');

// Example configuration with query parameters
const configuration = {
  iceServers: [
    // Basic STUN server without query params
    {
      urls: 'stun:stun.l.google.com:19302'
    },
    
    // TURN server with transport parameter
    {
      urls: 'turn:turn.example.com:3478?transport=udp',
      username: 'user123',
      credential: 'pass456'
    },
    
    // TURN server with multiple query parameters
    {
      urls: 'turn:turn.example.com:3478?transport=tcp&ttl=86400',
      username: 'user123',
      credential: 'pass456'
    },
    
    // Multiple URLs with different transports
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp' // Secure TURN
      ],
      username: 'cloudflare_user',
      credential: 'cloudflare_pass'
    }
  ]
};

async function demonstrateQueryParams() {
  console.log('WebRTC Query String Parameters Demo\n');
  console.log('====================================\n');

  // Create peer connection
  const pc = new RTCPeerConnection(configuration);
  
  console.log('ICE Server Configuration:');
  console.log(JSON.stringify(configuration, null, 2));
  console.log();

  // The RTCIceTransport will parse these URLs internally
  console.log('✓ Configuration accepted');
  console.log('✓ Query parameters will be parsed during ICE gathering');
  console.log();

  // Demonstrate URL parsing (using internal method)
  const { RTCIceTransport } = require('../src/ice/RTCIceTransport');
  const transport = new RTCIceTransport();

  console.log('Example URL Parsing Results:');
  console.log('----------------------------');

  const testUrls = [
    'stun:stun.example.com:3478',
    'turn:turn.example.com:3478?transport=udp',
    'turn:turn.example.com:3478?transport=tcp&ttl=86400',
    'turns:turn.example.com:5349?transport=tcp&secure',
  ];

  testUrls.forEach(url => {
    const parsed = transport._parseServerUrl(url);
    console.log(`\nURL: ${url}`);
    console.log(`  Protocol: ${parsed.protocol}`);
    console.log(`  Host: ${parsed.host}`);
    console.log(`  Port: ${parsed.port}`);
    console.log(`  Transport: ${parsed.transport}`);
    console.log(`  Extra params:`, parsed.params);
  });

  console.log('\n\nQuery Parameter Use Cases:');
  console.log('--------------------------');
  console.log('• transport=udp/tcp  - Select UDP or TCP transport');
  console.log('• ttl=86400          - Set allocation lifetime (TURN)');
  console.log('• secure             - Flag for secure connection');
  console.log('• Custom parameters  - Can be used for vendor-specific features');

  transport.stop();
  pc.close();

  console.log('\n✓ Demo completed successfully');
}

// Run the demo
demonstrateQueryParams().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
