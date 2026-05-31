# node-rtc-connection

[![npm version](https://img.shields.io/npm/v/node-rtc-connection.svg)](https://www.npmjs.com/package/node-rtc-connection)
[![npm downloads](https://img.shields.io/npm/dm/node-rtc-connection.svg)](https://www.npmjs.com/package/node-rtc-connection)
[![CI](https://github.com/nmhung1210/nodertc/actions/workflows/test.yml/badge.svg)](https://github.com/nmhung1210/nodertc/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/node/v/node-rtc-connection.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A from-scratch, pure-Node.js WebRTC data-channel implementation that
**interoperates with browsers**. No native dependencies — the entire ICE / DTLS
/ SCTP stack is built on Node's `crypto` and `dgram`. Written in TypeScript;
ships type declarations.

## Features

- ✅ **Browser interoperable**: Verified end-to-end against Chromium (Playwright) and OpenSSL
- ✅ **Real protocols, not stubs**: Genuine DTLS 1.2 handshake + SCTP association over UDP
- ✅ **ICE** (RFC 8445): connectivity checks with MESSAGE-INTEGRITY, host/srflx/relay candidates
- ✅ **STUN/TURN** (RFC 5389/5766): NAT traversal and relay for restrictive networks
- ✅ **DTLS 1.2** (RFC 6347): `ECDHE_ECDSA_AES128_GCM`, mutual auth, self-signed ECDSA certs
- ✅ **SCTP + DCEP** (RFC 8831/8832): ordered/unordered data channels, string + binary
- ✅ **W3C API**: familiar `RTCPeerConnection` / `RTCDataChannel` surface
- ✅ **Pure Node.js, no native deps**; CommonJS + ESM bundles with TypeScript types

## Installation

```bash
npm install node-rtc-connection
```

Works from both CommonJS and ES modules, and bundles TypeScript declarations:

```javascript
// CommonJS
const { RTCPeerConnection } = require('node-rtc-connection');

// ES modules / TypeScript
import { RTCPeerConnection } from 'node-rtc-connection';
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

### ICE server URLs

ICE server URLs are parsed with query-string support:

```javascript
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        'turn:turn.example.com:3478?transport=udp',
        'turn:turn.example.com:53?transport=udp'
      ],
      username: 'user',
      credential: 'pass'
    }
  ]
};
```

**URL format:** `stun:host[:port]` and `turn:host[:port][?transport=udp&...]`.
The default port is `3478` (`5349` for the `turns:` scheme).

> **Transport support:** connectivity currently uses **UDP only**. STUN
> reflexive and TURN relay candidates are gathered over UDP; `transport=tcp`
> and the `turns:` (TLS) scheme are parsed but not yet used for the data path,
> so list a UDP TURN URL for the relay to work. Unknown query parameters are
> preserved and ignored.

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

- **`examples/node-to-node.ts`** — Two node-rtc-connection peers in one process
  establish a real data channel and exchange string + binary messages. The
  quickest way to see the full ICE/DTLS/SCTP stack work.
- **`examples/browser-server.ts`** + **`examples/browser-client.html`** — A
  Node.js HTTP server that runs a node-rtc-connection peer (the offerer) and serves a chat
  page. A browser opens the page, runs its native `RTCPeerConnection` as the
  answerer, and the two establish a genuine WebRTC data channel over UDP.

Run them (the examples are TypeScript, run via `tsx`):
```bash
# Node ↔ Node
npm run example:node

# Node ↔ Browser — then open http://localhost:3000
npm run example:browser
```

> The browser example uses plain HTTP for signaling and folds ICE candidates
> into the SDP (non-trickle) to keep it simple. A production app would typically
> use WebSockets with trickle ICE.

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
- `send(data)` - Send `string`, `ArrayBuffer`, a typed array / `ArrayBufferView`, or a Node `Buffer`
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
- `binaryType` - `'arraybuffer'` (default) or `'blob'`; controls how received binary frames are delivered

## Requirements

- Node.js 18 or higher
- UDP network access for ICE connectivity (and to a TURN server, if used)

## Setting Up Your Own TURN Server

For production use, it's recommended to run your own TURN server using [coturn](https://github.com/coturn/coturn):

```bash
# Install coturn
apt-get install coturn

# Basic configuration
turnserver -v -L 0.0.0.0 -a -u user:password -r realm
```

## Development

The project is written in strict TypeScript. Sources live in `src/`; tests in
`test/` run directly through [`tsx`](https://github.com/privatenumber/tsx) (no
precompile step).

```bash
npm run build          # rollup → minified dist/ bundles + dist/types/ declarations
npm run typecheck      # strict tsc --noEmit over src + tests
npm test               # full suite (auto-starts a coturn container for the TURN test)
npm run test:unit      # SKIP_INTEGRATION=1 — no Docker / browser / external servers
npm run test:coverage  # full suite under c8
```

The full test suite proves interoperability against external references:
DTLS handshakes against `openssl`, an end-to-end data channel against real
Chromium (via Playwright), and a relay path against a real `coturn` server.
Integration tests skip gracefully when their dependency (Docker, openssl,
Chromium) is unavailable or when `SKIP_INTEGRATION=1`.

## License

MIT

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for
the development workflow and conventions, and our
[Code of Conduct](./CODE_OF_CONDUCT.md). Security issues should be reported
privately — see [SECURITY.md](./SECURITY.md). Release notes live in
[CHANGELOG.md](./CHANGELOG.md).

## Acknowledgments

This is a from-scratch, pure-Node.js implementation that follows the relevant
IETF RFCs (8445 ICE, 6347 DTLS 1.2, 8831 SCTP-over-DTLS, 8832 DCEP) and the W3C
WebRTC specification.
