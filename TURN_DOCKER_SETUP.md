# TURN Server Docker Setup

This document describes how to set up and test the local TURN server for NodeRTC development and testing.

## Overview

NodeRTC includes a Docker-based TURN server setup using [coturn](https://github.com/coturn/coturn), a popular open-source TURN/STUN server implementation. This allows for:

- **Local testing** without relying on public TURN servers
- **Reproducible tests** with known credentials and configuration
- **Integration testing** of the complete TURN relay flow
- **Development** without internet connectivity

## Quick Start

### 1. Start the TURN Server

```bash
./turn-server.sh start
```

This will:
- Pull the coturn Docker image (if not already present)
- Start the TURN server on port 3478
- Display the test credentials

### 2. Run Tests

```bash
./turn-server.sh test
```

This runs both:
- TURN unit tests (protocol implementation)
- TURN integration tests (end-to-end relay)

### 3. Stop the Server

```bash
./turn-server.sh stop
```

## Server Configuration

The TURN server is configured via `turnserver.conf`:

```
listening-port=3478
realm=nodertc.local
user=testuser:testpass
user=nodertc:nodertcpass
verbose
```

### Test Credentials

Two sets of credentials are available for testing:

1. **Primary**: `testuser` / `testpass`
2. **Alternative**: `nodertc` / `nodertcpass`

### Ports

- **3478**: TURN server (UDP/TCP)

## Management Commands

The `turn-server.sh` script provides several commands:

### start
Start the TURN server
```bash
./turn-server.sh start
```

### stop
Stop the TURN server
```bash
./turn-server.sh stop
```

### restart
Restart the TURN server
```bash
./turn-server.sh restart
```

### logs
View server logs (follow mode)
```bash
./turn-server.sh logs
```

### status
Check if server is running
```bash
./turn-server.sh status
```

### test
Run all TURN tests (unit + integration)
```bash
./turn-server.sh test
```

### test-unit
Run only TURN unit tests
```bash
./turn-server.sh test-unit
```

### test-integration
Run only TURN integration tests
```bash
./turn-server.sh test-integration
```

## Testing

### Unit Tests (`test/TURN.test.js`)

Tests the TURN protocol implementation:

- TURNClient basics (allocation, refresh, send)
- Mock TURN server responses
- ICE gatherer relay candidate discovery
- Public TURN server integration (Viagenie, Metered.ca)
- Docker TURN server integration

Run with:
```bash
npm run test:turn
# or
./turn-server.sh test-unit
```

### Integration Tests (`test/turn-integration.test.js`)

Tests end-to-end relay functionality:

- **Connection establishment** with relay candidates
- **Data transmission** through TURN relay
- **Candidate priority** verification (host > srflx > relay)

Run with:
```bash
npm run test:turn-integration
# or
./turn-server.sh test-integration
```

### All TURN Tests

Run everything:
```bash
npm run test:turn-all
# or
./turn-server.sh test
```

## Usage in Applications

### Configuration

```javascript
const { createPeerConnection } = require('nodertc');

const pc = createPeerConnection({
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:127.0.0.1:3478',
      username: 'testuser',
      credential: 'testpass'
    }
  ]
});
```

### ICE Candidate Gathering

```javascript
pc.on('icecandidate', (event) => {
  if (event.candidate) {
    const candidateStr = event.candidate.candidate;
    
    if (candidateStr.includes('typ relay')) {
      console.log('Got relay candidate via TURN!');
    }
  }
});

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

// Wait for ICE gathering to complete
// Relay candidates will be discovered automatically
```

## Troubleshooting

### Server Not Starting

Check if port 3478 is already in use:
```bash
sudo netstat -tulpn | grep 3478
```

### No Relay Candidates

1. Verify server is running:
   ```bash
   ./turn-server.sh status
   ```

2. Check server logs:
   ```bash
   ./turn-server.sh logs
   ```

3. Verify credentials match configuration

### Connection Timeout

Integration tests wait up to 8 seconds for connection. If tests timeout:

1. Check server is running
2. Verify no firewall blocking port 3478
3. Check logs for authentication errors

### Docker Issues

If Docker commands fail:

1. Ensure Docker is installed and running:
   ```bash
   docker --version
   docker ps
   ```

2. Check Docker Compose:
   ```bash
   docker-compose --version
   ```

3. Restart Docker service:
   ```bash
   sudo systemctl restart docker
   ```

## Architecture

```
┌─────────────────┐         ┌─────────────────┐
│   Peer A (PC1)  │         │   Peer B (PC2)  │
│                 │         │                 │
│  ICE Gatherer   │         │  ICE Gatherer   │
│  - Host         │         │  - Host         │
│  - Srflx (STUN) │         │  - Srflx (STUN) │
│  - Relay (TURN) │         │  - Relay (TURN) │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │  Allocate Request         │
         │  + Credentials            │
         └───────────┐   ┌───────────┘
                     ▼   ▼
              ┌──────────────┐
              │ TURN Server  │
              │ (coturn)     │
              │              │
              │ Port: 3478   │
              └──────────────┘
                     │
                     │ Relay
                     │ Data
                     ▼
         ┌───────────────────────┐
         │  Allocated Addresses  │
         │  - Peer A: IP:PORT    │
         │  - Peer B: IP:PORT    │
         └───────────────────────┘
```

## Protocol Flow

1. **Allocation**: Peer requests relay address from TURN server
2. **Authentication**: Server validates credentials
3. **Relay Address**: Server allocates and returns relay address
4. **ICE Candidate**: Relay address becomes ICE candidate
5. **Data Relay**: All data flows through TURN server
6. **Refresh**: Allocation refreshed periodically (600s default)

## Security Notes

### Test Environment Only

The provided credentials are for **testing only**:
- `testuser:testpass`
- `nodertc:nodertcpass`

**Do not use these credentials in production!**

### Production Deployment

For production TURN servers:

1. Use strong, unique credentials
2. Enable TLS/DTLS (port 5349)
3. Restrict access by IP/domain
4. Monitor resource usage
5. Use credential rotation
6. Consider using REST API for dynamic credentials

### Resource Limits

coturn configuration includes:
- Max connections per IP
- Max allocations per user
- Bandwidth limits
- Session timeouts

See `turnserver.conf` for details.

## Performance

### Relay Overhead

TURN relay adds latency compared to direct connection:
- **Direct (host)**: ~1ms local
- **STUN (srflx)**: ~10-50ms
- **TURN (relay)**: ~50-200ms

ICE automatically selects fastest path.

### Bandwidth

TURN server bandwidth = sum of all relay sessions.

For testing: typically <1 MB/s per connection

For production: size accordingly based on:
- Number of concurrent peers
- Expected data rate per connection
- 2x factor (bidirectional)

## Resources

- [RFC 5766: TURN Protocol](https://tools.ietf.org/html/rfc5766)
- [coturn Server](https://github.com/coturn/coturn)
- [WebRTC ICE](https://webrtc.org/getting-started/peer-connections)
- [STUN/TURN Guide](https://www.twilio.com/docs/stun-turn)

## Support

For issues with:
- **NodeRTC TURN client**: See `TURN_IMPLEMENTATION.md`
- **Docker setup**: Check this document
- **coturn server**: See [coturn docs](https://github.com/coturn/coturn/wiki)
