# NodeRTC

A Node.js WebRTC implementation with full ICE/STUN/TURN support for real peer-to-peer networking.

## Features

- ✅ **Real Network Transport**: Uses actual UDP/TCP sockets for true peer-to-peer connections
- ✅ **ICE Support**: Full Interactive Connectivity Establishment with candidate gathering
- ✅ **STUN Support**: NAT traversal with server reflexive candidates
- ✅ **TURN Support**: Relay candidates for restrictive network environments
- ✅ **Data Channels**: Reliable and ordered data channels for P2P communication
- ✅ **DTLS/SCTP**: Secure transport with DTLS encryption and SCTP for data channels
- ✅ **Standards Compliant**: Follows WebRTC and ICE specifications

## Installation

```bash
npm install node-rtc-connection
```

## Quick Start

### Basic Local Connection (No STUN/TURN)

```javascript
const { RTCPeerConnection } = require('node-rtc-connection');

// Create two peer connections
const pc1 = new RTCPeerConnection({ iceServers: [] });
const pc2 = new RTCPeerConnection({ iceServers: [] });

// Set up data channel on peer 1
const channel = pc1.createDataChannel('chat');

channel.on('open', () => {
  console.log('Channel opened!');
  channel.send('Hello from Peer 1!');
});

channel.on('message', (event) => {
  console.log('Received:', event.data);
});

// Peer 2 receives data channel
pc2.on('datachannel', (event) => {
  const channel = event.channel;
  
  channel.on('message', (event) => {
    console.log('Received:', event.data);
    channel.send('Hello from Peer 2!');
  });
});

// Exchange ICE candidates
pc1.on('icecandidate', (e) => {
  if (e.candidate) pc2.addIceCandidate(e.candidate);
});

pc2.on('icecandidate', (e) => {
  if (e.candidate) pc1.addIceCandidate(e.candidate);
});

// Signaling (offer/answer exchange)
async function connect() {
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  
  await pc2.setRemoteDescription(offer);
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  
  await pc1.setRemoteDescription(answer);
}

connect();
```

### With STUN Server (NAT Traversal)

```javascript
const { RTCPeerConnection } = require('node-rtc-connection');

const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
};

const pc = new RTCPeerConnection(config);

// Listen for gathered ICE candidates
pc.on('icecandidate', (event) => {
  if (event.candidate) {
    console.log('ICE Candidate:', event.candidate.candidate);
    // Send to remote peer via your signaling channel
  }
});

// Create offer and start ICE gathering
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

### With TURN Server (Relay Support)

```javascript
const { RTCPeerConnection } = require('node-rtc-connection');

const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:turn.example.com:3478',
      username: 'your-username',
      credential: 'your-password'
    }
  ]
};

const pc = new RTCPeerConnection(config);

pc.on('icecandidate', (event) => {
  if (event.candidate) {
    const candidate = event.candidate.candidate;
    
    // Check candidate type
    if (candidate.includes('typ relay')) {
      console.log('TURN relay candidate:', candidate);
    } else if (candidate.includes('typ srflx')) {
      console.log('STUN reflexive candidate:', candidate);
    } else if (candidate.includes('typ host')) {
      console.log('Host candidate:', candidate);
    }
  }
});
```

## Configuration Options

```javascript
const config = {
  // Array of ICE servers (STUN/TURN)
  iceServers: [
    { 
      urls: 'stun:stun.l.google.com:19302' 
    },
    {
      urls: [
        'turn:turn.example.com:3478?transport=udp',
        'turn:turn.example.com:3478?transport=tcp'
      ],
      username: 'user',
      credential: 'pass'
    }
  ],
  
  // ICE transport policy
  iceTransportPolicy: 'all', // 'all' or 'relay'
  
  // Bundle policy
  bundlePolicy: 'balanced', // 'balanced', 'max-bundle', or 'max-compat'
  
  // RTCP mux policy
  rtcpMuxPolicy: 'require', // 'negotiate' or 'require'
  
  // ICE candidate pool size
  iceCandidatePoolSize: 0
};

const pc = new RTCPeerConnection(config);
```

### Query String Parameters in Server URLs

The library supports query string parameters in ICE server URLs for advanced configuration:

```javascript
const config = {
  iceServers: [
    // Transport selection
    {
      urls: 'turn:turn.example.com:3478?transport=udp',
      username: 'user',
      credential: 'pass'
    },
    
    // Multiple parameters
    {
      urls: 'turn:turn.example.com:3478?transport=tcp&ttl=86400',
      username: 'user',
      credential: 'pass'
    },
    
    // Multiple URLs with different transports
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp'
      ],
      username: 'cloudflare_user',
      credential: 'cloudflare_pass'
    }
  ]
};
```

**Supported Query Parameters:**
- `transport=udp|tcp` - Select transport protocol (UDP or TCP)
- `ttl=<seconds>` - Set allocation lifetime for TURN (default: 600)
- Custom parameters - Can be added for vendor-specific features

**URL Format Examples:**
- `stun:host:port` - Basic STUN server
- `turn:host:port?transport=udp` - TURN with UDP transport
- `turn:host:port?transport=tcp&custom=value` - Multiple parameters
- `turns:host:port?transport=tcp` - Secure TURN over TLS

## Data Channel API

```javascript
// Create data channel with options
const channel = pc.createDataChannel('myChannel', {
  ordered: true,           // Guarantee message order
  maxRetransmits: 3,       // Max retransmissions (if not ordered)
  maxPacketLifeTime: 3000, // Max packet lifetime in ms
  protocol: 'custom',      // Sub-protocol
  negotiated: false,       // Manual negotiation
  id: 0                    // Channel ID (if negotiated)
});

// Events
channel.on('open', () => {
  console.log('Channel opened');
});

channel.on('close', () => {
  console.log('Channel closed');
});

channel.on('error', (error) => {
  console.error('Channel error:', error);
});

channel.on('message', (event) => {
  console.log('Message received:', event.data);
});

// Send data
channel.send('Hello World');
channel.send(Buffer.from([1, 2, 3, 4])); // Binary data

// Close channel
channel.close();
```

## RTCPeerConnection Events

```javascript
const pc = new RTCPeerConnection(config);

// ICE candidate discovered
pc.on('icecandidate', (event) => {
  // event.candidate contains the ICE candidate
});

// ICE gathering state changed
pc.on('icegatheringstatechange', () => {
  console.log('Gathering state:', pc.iceGatheringState);
  // 'new', 'gathering', or 'complete'
});

// ICE connection state changed
pc.on('iceconnectionstatechange', () => {
  console.log('ICE state:', pc.iceConnectionState);
  // 'new', 'checking', 'connected', 'completed', 'failed', 'disconnected', 'closed'
});

// Connection state changed
pc.on('connectionstatechange', () => {
  console.log('Connection state:', pc.connectionState);
  // 'new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'
});

// Signaling state changed
pc.on('signalingstatechange', () => {
  console.log('Signaling state:', pc.signalingState);
  // 'stable', 'have-local-offer', 'have-remote-offer', 'have-local-pranswer', 'have-remote-pranswer', 'closed'
});

// Data channel received (for answerer)
pc.on('datachannel', (event) => {
  const channel = event.channel;
  console.log('Received data channel:', channel.label);
});

// Negotiation needed
pc.on('negotiationneeded', () => {
  console.log('Negotiation needed');
});
```

## Complete Example: Two-Peer Communication

```javascript
const { RTCPeerConnection } = require('node-rtc-connection');

async function createPeerConnection() {
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };

  // Create peer connections
  const offerer = new RTCPeerConnection(config);
  const answerer = new RTCPeerConnection(config);

  // Exchange ICE candidates
  offerer.on('icecandidate', (e) => {
    if (e.candidate) answerer.addIceCandidate(e.candidate);
  });

  answerer.on('icecandidate', (e) => {
    if (e.candidate) offerer.addIceCandidate(e.candidate);
  });

  // Set up data channel on offerer
  const channel = offerer.createDataChannel('chat');

  channel.on('open', () => {
    console.log('Offerer: Channel opened');
    channel.send('Hello from offerer!');
  });

  channel.on('message', (event) => {
    console.log('Offerer received:', event.data);
  });

  // Answerer receives data channel
  answerer.on('datachannel', (event) => {
    const channel = event.channel;

    channel.on('open', () => {
      console.log('Answerer: Channel opened');
    });

    channel.on('message', (event) => {
      console.log('Answerer received:', event.data);
      channel.send('Hello from answerer!');
    });
  });

  // Perform signaling
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);

  await answerer.setRemoteDescription(offer);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);

  await offerer.setRemoteDescription(answer);

  // Wait for connection
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Clean up
  channel.close();
  offerer.close();
  answerer.close();
}

createPeerConnection().catch(console.error);
```

## Example Files

The package includes runnable examples in `examples/`:

- **`examples/node-to-node.js`** — Two NodeRTC peers in one process establish a
  real data channel and exchange string + binary messages. The quickest way to
  see the full ICE/DTLS/SCTP stack work.
- **`examples/browser-server.js`** + **`examples/browser-client.html`** — A
  Node.js HTTP server that runs a NodeRTC peer (the offerer) and serves a chat
  page. A browser opens the page, runs its native `RTCPeerConnection` as the
  answerer, and the two establish a genuine WebRTC data channel over UDP.

Run them:
```bash
# Node ↔ Node
npm run example:node      # or: node examples/node-to-node.js

# Node ↔ Browser — then open http://localhost:3000
npm run example:browser   # or: node examples/browser-server.js
```

> The browser example uses plain HTTP for signaling and folds ICE candidates
> into the SDP (non-trickle) to keep it simple. A production app would typically
> use WebSockets with trickle ICE.

## Configuration File

The examples use a `peer.config.json` file for centralized configuration:

```json
{
  "iceServers": [
    { "urls": "stun:stun.l.google.com:19302" }
  ],
  "localDemo": {
    "iceServers": []
  },
  "stunOnly": {
    "iceServers": [
      { "urls": "stun:stun.l.google.com:19302" }
    ]
  },
  "turnConfig": {
    "iceServers": [
      { "urls": "stun:stun.example.com:3478" },
      {
        "urls": "turn:turn.example.com:3478",
        "username": "user",
        "credential": "pass"
      }
    ]
  }
}
```

## API Reference

### RTCPeerConnection

#### Constructor
```javascript
new RTCPeerConnection(configuration?)
```

#### Methods
- `createOffer(options?)` - Create SDP offer
- `createAnswer(options?)` - Create SDP answer
- `setLocalDescription(description)` - Set local SDP
- `setRemoteDescription(description)` - Set remote SDP
- `addIceCandidate(candidate)` - Add remote ICE candidate
- `createDataChannel(label, options?)` - Create data channel
- `close()` - Close the connection

#### Properties
- `localDescription` - Local SDP description
- `remoteDescription` - Remote SDP description
- `signalingState` - Current signaling state
- `iceGatheringState` - ICE gathering state
- `iceConnectionState` - ICE connection state
- `connectionState` - Overall connection state

### RTCDataChannel

#### Methods
- `send(data)` - Send data (string or Buffer)
- `close()` - Close the channel

#### Properties
- `label` - Channel label
- `ordered` - Whether messages are ordered
- `maxRetransmits` - Maximum retransmissions
- `maxPacketLifeTime` - Maximum packet lifetime
- `protocol` - Sub-protocol
- `negotiated` - Whether manually negotiated
- `id` - Channel ID
- `readyState` - Current state ('connecting', 'open', 'closing', 'closed')
- `bufferedAmount` - Bytes queued to send

## Requirements

- Node.js 14 or higher
- UDP/TCP network access for ICE connectivity

## Setting Up Your Own TURN Server

For production use, it's recommended to run your own TURN server using [coturn](https://github.com/coturn/coturn):

```bash
# Install coturn
apt-get install coturn

# Basic configuration
turnserver -v -L 0.0.0.0 -a -u user:password -r realm
```

## License

BSD-3-Clause

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## Acknowledgments

This implementation is inspired by and follows the WebRTC standards and specifications, with particular reference to Chromium's WebRTC implementation.
