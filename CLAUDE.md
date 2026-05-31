# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`node-rtc-connection` is a pure-Node.js (no native deps) WebRTC DataChannel
library exposing a browser-compatible `RTCPeerConnection` / `RTCDataChannel`
API. It targets data channels only — no media streams.

## Commands

```bash
npm run build            # Bundle src/ → dist/index.cjs + dist/index.mjs (rollup)
npm test                 # Run all *.test.js via test/run-all-tests.js (node:test)
npm run test:unit        # Unit tests only, SKIP_INTEGRATION=1
npm run test:integration # Integration test only
npm run test:watch       # node --test --watch

# Run a single test file
node --test test/RTCDataChannel.test.js
# Run a single named test
node --test --test-name-pattern="creates a data channel" test/RTCDataChannel.test.js
```

`SKIP_INTEGRATION=1` is honored by tests that open real sockets / reach external
STUN/TURN servers — set it when working offline. CI (`.github/workflows/test.yml`)
runs the full suite against Node 18/20/22 with a `coturn` TURN server sidecar
(users `testuser:testpass`, `nodertc:nodertcpass`, realm `nodertc.local`).

## Architecture

This is a **real, browser-interoperable WebRTC implementation in pure Node.js**
(verified against headless Chrome and OpenSSL — see Verification below). The
protocol bytes are genuine; nothing is stubbed.

`RTCPeerConnection` (`src/peerconnection/`) handles signaling (offer/answer +
ICE candidate trickle) and delegates the wire protocols to `TransportStack`
(`src/transport-stack.js`), which composes four real layers:

```
RTCPeerConnection            signaling, SDP, channel lifecycle
  └─ TransportStack          wires the layers together + role negotiation
       ├─ IceAgent (src/ice/ice-agent.js)        RFC 8445 connectivity checks over UDP
       ├─ DtlsConnection (src/dtls/connection.js) DTLS 1.2 handshake + record layer
       ├─ SctpAssociation (src/sctp/association.js) SCTP assoc, DATA/SACK, reassembly
       └─ DataChannelManager (src/sctp/datachannel-manager.js) DCEP + stream mapping
```

Datagram flow (one UDP socket per RFC 7983 demux):
`IceAgent` 'data' (non-STUN) → `DtlsConnection.handlePacket` → decrypted app
records → `SctpAssociation.receivePacket` → DCEP/`RTCDataChannel`. Outbound runs
the reverse: SCTP packet → `DtlsConnection.send` (encrypt) → `IceAgent.send`.

`src/index.js` is the single entry point. `src/index.d.ts` holds hand-written
TypeScript types (keep in sync manually).

### Layer specifics

- **Crypto foundation** (`src/crypto/`): `der.js` is a minimal ASN.1/DER encoder;
  `x509.js` builds a self-signed ECDSA P-256 certificate. The SDP `a=fingerprint`
  is SHA-256 over the **DER certificate** (RFC 8122) — not the public key.
  `RTCCertificate` wraps this and exposes `getCertificateDer()` /
  `getPrivateKeyObject()` for the DTLS handshake.
- **DTLS** (`src/dtls/`): cipher suite `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256`
  only, secp256r1, extended master secret, mutual auth, HelloVerifyRequest
  cookie. `prf.js`/`cipher.js`/`protocol.js`/`connection.js`. **Gotcha:**
  CertificateVerify & ServerKeyExchange sign the *raw* handshake transcript —
  `crypto.sign('sha256', …)` hashes internally, so never pre-hash.
- **SCTP** (`src/sctp/`): `crc32c.js` (Castagnoli), `chunks.js` (codec),
  `association.js` (4-way INIT/COOKIE setup, TSN, SACK with gap blocks,
  fragmentation), `dcep.js` (RFC 8832 OPEN/ACK on PPID 50). Stream IDs: DTLS
  client uses even, server odd. PPIDs: string 51/56, binary 53/57.
- **ICE** (`src/ice/ice-agent.js` + `stun-message.js`): connectivity checks
  carry USERNAME, MESSAGE-INTEGRITY (HMAC-SHA1 keyed by ice-pwd), FINGERPRINT,
  PRIORITY, ICE-CONTROLLING/CONTROLLED, USE-CANDIDATE. Aggressive nomination.

### Legacy modules (still present, used only by STUN/TURN tests)

`src/ice/RTCIceTransport.js`, `src/stun/stun-client.js`, and
`src/network/network-transport.js` are the **old** transport classes. The real
data path no longer uses them; `stun-client.js` remains a correct STUN/TURN
client and `RTCIceTransport._parseServerUrl` backs `url-parsing`/`turn-support`
tests. Don't route data-channel work through these — use the `src/ice/ice-agent`
+ `TransportStack` path.

### Role negotiation

Offerer is ICE-**controlling**; answerer is **controlled**. DTLS roles follow
`a=setup`: offerer sends `actpass`, answerer picks `active` (→ DTLS client), so
offerer becomes DTLS server. The DTLS client is also the SCTP INIT initiator
(RFC 8832). See `_setupRolesAndStack` in `RTCPeerConnection.js`.

## Verification (how correctness is proven, not assumed)

Each layer has an external-reference test, not just self-loopback:

- `test/x509.test.js` — cert validated by Node's `X509Certificate.verify()`.
- `test/dtls-openssl-interop.test.js` — **handshakes with `openssl s_server`/
  `s_client`** (DTLS 1.2, mutual auth) in both roles.
- `test/sctp-loopback.test.js`, `test/datachannel-stack.test.js`,
  `test/transport-stack.test.js` — SCTP/DCEP and the full ICE+DTLS+SCTP pipeline
  over real UDP.
- `test/browser-interop.test.js` — **drives headless Chrome** through
  `test/browser/run-browser-interop.js`; asserts a data channel opens and
  string + binary flow both directions. The authoritative interop proof.

Interop tests skip gracefully when openssl/Chrome are absent or
`SKIP_INTEGRATION=1`. Set `CHROME_PATH` to override Chrome discovery.

## Conventions

- CommonJS throughout (`require`/`module.exports`); `"type": "commonjs"`.
- Tests use `node:test` + `node:assert`; `test/run-all-tests.js` recurses into
  `test/integration` and runs `test/browser-interop.test.js` (but not the
  `test/browser/` support code or `test/helpers/`).
- `dist/` is generated — never edit by hand; rebuild with `npm run build`.
- All protocol layers extend `EventEmitter` and communicate via events.
