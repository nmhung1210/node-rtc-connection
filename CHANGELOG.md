# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Memory leaks on teardown and unbounded buffers (no public API change):
  - **Data channels** are now released when they close. The
    `DataChannelManager` dropped channels into a Map that only ever grew and
    kept a permanent `SEND` listener per channel; closing a channel now emits an
    internal event so the manager deletes the entry and detaches its listeners,
    and `DataChannelManager.close()` removes its SCTP `message` listener and
    clears all channels. `RTCDataChannel` also detaches its own internal
    transport listeners on close. Fixes a real leak for apps that churn channels.
  - **`RTCPeerConnection.close()`** now nulls the transport stack, removes its
    listeners, and clears the pending-channel / local-candidate collections, so
    closing a connection releases the ICE→DTLS→SCTP graph instead of pinning it
    for the object's lifetime. `TransportStack.close()` tears down the
    `DataChannelManager` (previously never closed).
  - **SCTP** clears its retransmit, reassembly, and gap buffers on close/abort
    (they hold full payload Buffers and can never drain once closed), and bounds
    the out-of-order gap buffer to roughly the advertised receive window so a
    stuck or malicious gap can't grow it without limit.
  - **DTLS** frees the handshake transcript (which holds both DER certificates),
    the last retransmit flight, the reassembly map, and spent key-exchange
    material once the handshake completes (and on close/fail) — the bulk of the
    per-connection memory, retained for the connection's lifetime before.
  - **ICE** clears its pending-checks map when checks stop and retires a
    candidate pair's previous transaction id on each retransmit, so unanswered
    connectivity checks no longer accumulate stale entries every tick.

## [2.0.10] - 2026-06-02

### Fixed
- DTLS client now interoperates with peers that skip HelloVerifyRequest (browsers
  do for data-channel DTLS). The first (cookieless) ClientHello is folded into
  the handshake transcript when no cookie exchange occurs (RFC 6347 §4.2.1), so
  the client's CertificateVerify signature and Finished MAC match what the peer
  computes. Previously, acting as the answerer against a browser failed with
  `DTLS fatal alert: 51` (decrypt_error); the OpenSSL `s_server` interop test
  masked it because OpenSSL sends HelloVerifyRequest by default. Covered by a new
  reversed-role (browser-offers, Node-answers) browser interop test.

## [2.0.9] - 2026-06-02

### Added
- Configurable TLS certificate validation for TURN-over-TLS (`turns:`). Cert
  validation is on by default; an option allows bypassing it for self-signed
  relays. Documented alongside the `turns:` TLS/DTLS transport options.

### Fixed
- SCTP SACK gap-ack uint16 overflow on large TSN gaps.
- Host process no longer crashes on a peer transport error (SCTP ABORT); the
  error is surfaced rather than thrown unhandled.
- Code-scanning fixes: avoid broken/weak cryptographic algorithms, use secure
  randomness, and stop disabling certificate validation unconditionally.

### Changed
- Node-to-node example updated to use a TURN server; browser example now reads
  TURN/STUN config from an env file.
- Bumped rollup 4.54.0 → 4.61.0.

## [2.0.8] - 2026-06-01

Re-publish; no source changes.

## [2.0.7] - 2026-06-01

Re-publish; no source changes.

## [2.0.6] - 2026-06-01

### Added
- TURN-over-DTLS and TURN-over-TLS (`turns:`) transport support, with end-to-end
  tests and Docker-free unit tests.

### Changed
- Bumped picomatch 4.0.3 → 4.0.4.

## [2.0.5] - 2026-05-31

### Changed
- Smaller published bundle: ES2022 native private fields, stripped comments, two
  terser passes.
- Publish from `dist/` with a generated minimal `dist/package.json`; exclude
  `src` from the published package.

## [2.0.4] - 2026-05-31

### Fixed
- Corrected the repository URL to `node-rtc-connection` so npm provenance
  matches.

## [2.0.3] - 2026-05-31

Re-publish; no source changes.

## [2.0.2] - 2026-05-31

### Changed
- Publish CI reuses the Test workflow as its gate; browser test is skipped when
  Chromium is missing and Chromium is installed in publish CI.
- README: use the `node-rtc-connection` name, add badges.

### Added
- Open-source community docs.

## [2.0.1] - 2026-05-31

### Changed
- Publish workflow updated for the TypeScript build and coturn-backed tests.
- README: package name, badges, and TypeScript/UDP-only documentation.

## [2.0.0] - 2026-05-31

A ground-up rewrite into a **real, browser-interoperable WebRTC stack** written
in **strict TypeScript**. Earlier 1.x releases only simulated WebRTC (fake DTLS/
SCTP state machines over a plain-TCP/JSON side channel) and could not talk to a
browser.

### Added
- Real **ICE** agent (RFC 8445): connectivity checks with USERNAME,
  MESSAGE-INTEGRITY, FINGERPRINT, PRIORITY, ICE-CONTROLLING/CONTROLLED,
  USE-CANDIDATE; host, server-reflexive (STUN), and relay (TURN) candidate
  gathering; `iceTransportPolicy: 'relay'` support.
- Real **DTLS 1.2** (RFC 6347): `TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256`,
  secp256r1, extended master secret, mutual authentication, HelloVerifyRequest
  cookie, handshake fragmentation and retransmission — verified to interoperate
  with OpenSSL in both client and server roles.
- Real **SCTP over DTLS** + **DCEP** (RFC 8831 / 8832): CRC32c, INIT/COOKIE
  association setup, DATA/SACK with TSN tracking and gap blocks, message
  fragmentation/reassembly, ordered and unordered delivery.
- Self-signed **ECDSA P-256 X.509** certificate generation with RFC 8122
  fingerprints (pure Node `crypto`, no native deps).
- End-to-end **browser interoperability** verified against real Chromium via
  Playwright (string + binary data both directions, direct and TURN-relayed).
- TypeScript type declarations shipped with the package; CommonJS + ESM bundles.
- Test coverage tooling (c8) with CI-enforced thresholds.

### Changed
- Entire codebase migrated to strict TypeScript; class internals use
  ECMAScript `#` private fields. `RTCDataChannel` ↔ SCTP wiring is event-driven.
- `RTCPeerConnection` rewritten to orchestrate the real ICE → DTLS → SCTP → DCEP
  pipeline with offer/answer and ICE candidate trickling.
- SDP now uses the standard `m=application 9 UDP/DTLS/SCTP` profile with real
  ICE candidates and DER-based DTLS fingerprints.
- Build now produces minified bundles without sourcemaps.

### Fixed
- Binary `channel.send()` payloads are no longer corrupted (previously
  JSON-serialized); binary frames round-trip as `ArrayBuffer`/`Buffer`.

### Removed
- Fake `RTCIceTransport` / `RTCDtlsTransport` / `RTCSctpTransport` state-machine
  classes and the plain-TCP/JSON `network-transport` data path.
- Vendored Chromium reference sources (`cc/`).

### Requirements
- **Node.js 18 or higher** (previously 14).

## [1.x]

Pre-rewrite releases. See the Git tag history (`v1.0.1` … `v1.0.19`) for
details. These versions exposed a WebRTC-shaped API but did not implement the
real wire protocols and were not browser-interoperable.

[2.0.1]: https://github.com/nmhung1210/node-rtc-connection/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/nmhung1210/node-rtc-connection/compare/v1.0.19...v2.0.0
