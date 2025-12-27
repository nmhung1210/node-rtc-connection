# NodeRTC - WebRTC DataChannels for Node.js

[![npm version](https://badge.fury.io/js/nodertc.svg)](https://www.npmjs.com/package/nodertc)
[![Node.js CI](https://github.com/nmhung1210/nodertc/workflows/Test/badge.svg)](https://github.com/nmhung1210/nodertc/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-ready WebRTC DataChannel implementation for Node.js with **real networking**, **STUN/TURN support**, **MESSAGE-INTEGRITY authentication**, and **optional encryption**. Built with pure Node.js - no native dependencies required.

## Overview

NodeRTC provides WebRTC-style peer-to-peer data connections using Node.js built-in modules. It supports NAT traversal via STUN/TURN servers with full RFC 5766 MESSAGE-INTEGRITY authentication, optional TLS encryption, and works across the internet for most network configurations.

## Features

- ✅ **RTCPeerConnection** - Full peer connection lifecycle
- ✅ **RTCDataChannel** - Bidirectional data channels
- ✅ **STUN Support** - NAT traversal with public STUN servers
- ✅ **TURN Support** - Relay through TURN servers (RFC 5766)
- ✅ **MESSAGE-INTEGRITY** - Full authentication support for TURN
- ✅ **ICE Candidates** - Host, server reflexive, and relay candidates
- ✅ **TLS Encryption** - Optional secure connections
- ✅ **Real Networking** - TCP/UDP with actual peer-to-peer communication
- ✅ **Event-based API** - Built on Node.js EventEmitter
- ✅ **Zero Dependencies** - Pure Node.js, no native modules
- ✅ **Docker TURN Server** - Included for testing and development
- ❌ **No Media Support** - DataChannel only (no audio/video)

## Installation

```bash
npm install nodertc
```

## Quick Start

### Basic Usage

```javascript
const { createPeerConnection } = require('nodertc');

// Create peer connection
const pc = createPeerConnection();

// Create a data channel
const channel = pc.createDataChannel('myChannel');

channel.on('open', () => {
  console.log('DataChannel opened');
  channel.send('Hello, peer!');
});

channel.on('message', (event) => {
  console.log('Received:', event.data.toString());
});

// Handle ICE candidates
pc.on('icecandidate', (event) => {
  if (event.candidate) {
    // Send to remote peer via signaling
  }
});

// Create and set local description
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

### With STUN and TURN (Recommended)

```javascript
const { createPeerConnection } = require('nodertc');

// Configuration with STUN and TURN
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.example.com:3478',
      username: 'username',
      credential: 'password'
    }
  ],
  encryption: false,  // Optional TLS encryption
  transport: 'tcp'    // Use TCP (or 'udp')
};

// Create peer connection
const pc = createPeerConnection(config);

// Rest is the same as basic usage...

channel.on('message', (event) => {
  console.log('Received:', event.data.toString());
});

// ICE candidates (includes STUN reflexive candidates)
pc.on('icecandidate', (event) => {
  if (event.candidate) {
    // Send to remote peer via signaling
    console.log('Candidate:', event.candidate.candidate);
  }
});
```

See [examples/with-stun-encryption.js](examples/with-stun-encryption.js) for a complete working example.

## Usage

### Basic Example

```javascript
const { createPeerConnection } = require('./src');

// Create peer connection with STUN server
const pc = createPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
});

// Create a data channel
const channel = pc.createDataChannel('myChannel', {
  ordered: true
});

// Handle channel events
channel.on('open', () => {
  console.log('DataChannel opened');
  channel.send('Hello, peer!');
});

channel.on('message', (event) => {
  console.log('Received:', event.data);
});

channel.on('close', () => {
  console.log('DataChannel closed');
});

// Handle peer connection events
pc.on('icecandidate', (event) => {
  if (event.candidate) {
    // Send candidate to remote peer via signaling
    console.log('ICE candidate:', event.candidate);
  }
});

pc.on('datachannel', (event) => {
  // Handle incoming data channel from remote peer
  const remoteChannel = event.channel;
  console.log('Remote channel opened:', remoteChannel.label);
});

// Create and send offer
pc.createOffer()
  .then(offer => pc.setLocalDescription(offer))
  .then(() => {
    // Send offer to remote peer via signaling
    console.log('Offer created:', pc.localDescription);
  });
```

### Complete Signaling Example

```javascript
const { createPeerConnection } = require('./src');

// Peer 1 (Offerer)
const pc1 = createPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

// Peer 2 (Answerer)
const pc2 = createPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

// Exchange ICE candidates
pc1.on('icecandidate', (event) => {
  if (event.candidate) {
    pc2.addIceCandidate(event.candidate);
  }
});

pc2.on('icecandidate', (event) => {
  if (event.candidate) {
    pc1.addIceCandidate(event.candidate);
  }
});

// Handle incoming data channel on peer 2
pc2.on('datachannel', (event) => {
  const channel = event.channel;
  channel.on('message', (event) => {
    console.log('Peer 2 received:', event.data);
    channel.send('Hello from Peer 2!');
  });
});

// Create data channel on peer 1
const channel = pc1.createDataChannel('chat');

channel.on('open', () => {
  console.log('Channel opened');
  channel.send('Hello from Peer 1!');
});

channel.on('message', (event) => {
  console.log('Peer 1 received:', event.data);
});

// Start signaling
async function connect() {
  // Create offer
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  
  // Set remote description on peer 2
  await pc2.setRemoteDescription(offer);
  
  // Create answer
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  
  // Set remote description on peer 1
  await pc1.setRemoteDescription(answer);
}

connect();
```

## API Reference

### RTCPeerConnection

#### Constructor
```javascript
new RTCPeerConnection(configuration, nativePeerConnectionFactory)
```

#### Properties
- `signalingState` - Current signaling state
- `iceGatheringState` - Current ICE gathering state
- `iceConnectionState` - Current ICE connection state
- `connectionState` - Current connection state
- `localDescription` - Local session description
- `remoteDescription` - Remote session description

#### Methods
- `createOffer(options)` - Create an SDP offer
- `createAnswer(options)` - Create an SDP answer
- `setLocalDescription(description)` - Set local description
- `setRemoteDescription(description)` - Set remote description
- `addIceCandidate(candidate)` - Add an ICE candidate
- `createDataChannel(label, options)` - Create a data channel
- `getConfiguration()` - Get current configuration
- `setConfiguration(configuration)` - Update configuration
- `close()` - Close the peer connection
- `getStats()` - Get connection statistics

#### Events
- `signalingstatechange` - Signaling state changed
- `iceconnectionstatechange` - ICE connection state changed
- `icegatheringstatechange` - ICE gathering state changed
- `connectionstatechange` - Connection state changed
- `icecandidate` - New ICE candidate available
- `datachannel` - Remote data channel opened
- `negotiationneeded` - Negotiation needed

### RTCDataChannel

#### Properties
- `label` - Channel label
- `ordered` - Whether messages are ordered
- `maxPacketLifeTime` - Maximum packet lifetime
- `maxRetransmits` - Maximum retransmits
- `protocol` - Subprotocol name
- `negotiated` - Whether channel was negotiated
- `id` - Channel ID
- `readyState` - Current state: 'connecting', 'open', 'closing', 'closed'
- `bufferedAmount` - Bytes queued to send
- `bufferedAmountLowThreshold` - Threshold for bufferedamountlow event
- `binaryType` - Binary data format: 'arraybuffer' or 'blob'

#### Methods
- `send(data)` - Send data (string, ArrayBuffer, or ArrayBufferView)
- `close()` - Close the channel

#### Events
- `open` - Channel opened
- `close` - Channel closed
- `message` - Message received
- `error` - Error occurred
- `bufferedamountlow` - Buffered amount dropped below threshold

## Testing

NodeRTC includes comprehensive unit tests covering all components:

```bash
# Run all unit tests (fast, ~500ms)
npm test

# Run tests in watch mode
npm run test:watch

# Run integration tests (slower, uses real networking)
npm run test:integration

# Run all tests including integration
npm run test:all
```

**Test Coverage**: 96 unit tests with 100% pass rate. See [TEST_COVERAGE.md](TEST_COVERAGE.md) for detailed coverage information.

## Implementation Notes

### Current Implementation

This implementation uses **real Node.js networking** via the `net` package for peer-to-peer TCP connections:

- ✅ **Real TCP connections** between peers
- ✅ **Actual data transmission** over sockets
- ✅ **Real SDP generation** with network addresses
- ✅ **Working ICE candidates** with local IP addresses
- ✅ **Bidirectional messaging** between data channels
- ✅ **Connection lifecycle** management

The `NativePeerConnectionFactory` creates TCP servers and clients to establish peer-to-peer connections. Data channels transmit messages over these TCP connections using a simple framing protocol.

### How It Works

1. **Offer/Answer Exchange**: Peers exchange SDP containing their IP address and port
2. **TCP Server**: Each peer creates a TCP server listening on a random port
3. **Connection**: The answerer connects to the offerer's TCP server
4. **Data Channel Protocol**: Messages are framed with length + channel label + data
5. **Bidirectional Communication**: Both peers can send and receive on the established socket

### Example Output

```bash
$ node examples/real-networking.js

✓ PC1: Data channel opened!
✓ PC2: Data channel opened!

PC1: Sending first message...
📨 PC2 received: Hello from Peer 1!
PC2: Sending reply...
📨 PC1 received: Hello from Peer 2! Nice to meet you.
```

## Development & Contributing

### Setup

```bash
git clone https://github.com/nmhung1210/nodertc.git
cd nodertc
npm install
```

### Testing

```bash
# Run all tests
npm test

# Run specific test suites
npm run test:stun      # STUN tests
npm run test:turn      # TURN tests
npm run test:integration  # Integration tests
```

### Building

```bash
npm run build
```

This creates CommonJS and ES Module bundles in `dist/`.

### CI/CD

This project uses GitHub Actions for automated testing and publishing:

- **Test Workflow**: Runs on push/PR, tests on Node.js 18.x, 20.x, 22.x
- **Publish Workflow**: Triggers on version tags, automatically publishes to NPM

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed publishing instructions.

## Differences from Browser WebRTC

### Not Included (DataChannel-only focus)
- ❌ MediaStream / MediaStreamTrack
- ❌ getUserMedia
- ❌ RTCRtpSender / RTCRtpReceiver
- ❌ RTCRtpTransceiver
- ❌ Audio/Video codecs
- ❌ RTCDTMFSender
- ❌ Media constraints

### Simplified
- Event handling uses Node.js EventEmitter instead of DOM events
- No dependency on browser APIs
- Synchronous where possible (async only for native operations)

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Credits

Ported from Chromium's WebRTC implementation:
- Original source: `third_party/blink/renderer/modules/peerconnection/`
- Copyright (C) 2012 Google Inc.

## Links

- [NPM Package](https://www.npmjs.com/package/nodertc)
- [GitHub Repository](https://github.com/nmhung1210/nodertc)
- [Issues](https://github.com/nmhung1210/nodertc/issues)
- [Contributing Guide](CONTRIBUTING.md)
