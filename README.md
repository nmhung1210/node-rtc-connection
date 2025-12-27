# NodeRTC - DataChannel-only WebRTC for Node.js

A DataChannel-only WebRTC implementation for Node.js, ported from Chromium's PeerConnection implementation. This library focuses solely on DataChannel functionality and does not include media stream support (audio/video).

## Overview

This project ports the core PeerConnection and DataChannel classes from Chromium's C++ implementation to JavaScript for Node.js. It provides a clean, event-driven API for establishing peer-to-peer data connections.

## Features

- ✅ **RTCPeerConnection** - Full peer connection lifecycle management
- ✅ **RTCDataChannel** - Bidirectional data channel communication
- ✅ **RTCSessionDescription** - SDP offer/answer handling
- ✅ **RTCIceCandidate** - ICE candidate processing
- ✅ **Event-based API** - Built on Node.js EventEmitter
- ❌ **No Media Support** - Audio/video streams not included (DataChannel only)

## Architecture

### Ported Classes

The following classes were ported from `cc/` (Chromium C++ source):

- `RTCPeerConnection` - Main peer connection class (from `rtc_peer_connection.cc/h`)
- `RTCDataChannel` - Data channel implementation (from `rtc_data_channel.cc/h`)
- `RTCSessionDescription` - Session description wrapper (from `rtc_session_description.cc/h`)
- `RTCIceCandidate` - ICE candidate representation (from `rtc_ice_candidate.cc/h`)
- Event classes: `RTCDataChannelEvent`, `RTCPeerConnectionIceEvent`, `RTCError`

### File Structure

```
src/
├── index.js                        # Main entry point and exports
├── RTCPeerConnection.js           # PeerConnection implementation
├── RTCDataChannel.js              # DataChannel implementation
├── RTCSessionDescription.js       # Session description
├── RTCIceCandidate.js             # ICE candidate
├── RTCDataChannelEvent.js         # DataChannel events
├── RTCPeerConnectionIceEvent.js   # ICE events
├── RTCError.js                    # Error classes
└── NativePeerConnectionFactory.js # Native binding factory (mock)
```

## Installation

```bash
npm install
```

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

### For Production Use

To use this with real WebRTC functionality, replace `NativePeerConnectionFactory` with a native binding to a WebRTC library:

1. **node-webrtc** - Native WebRTC bindings for Node.js
2. **wrtc** - WebRTC implementation for Node.js
3. Custom native addon using libwebrtc

Example with node-webrtc:
```javascript
const wrtc = require('wrtc');
const { RTCPeerConnection } = require('./src');

// Use native RTCPeerConnection
const pc = new wrtc.RTCPeerConnection({
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});
```

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

## License

ISC

## Credits

Ported from Chromium's WebRTC implementation:
- Original source: `third_party/blink/renderer/modules/peerconnection/`
- Copyright (C) 2012 Google Inc.

