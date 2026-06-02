/**
 * @file connection.ts
 * @description DTLS 1.2 connection state machine (client and server roles).
 * @module dtls/connection
 *
 * Implements the handshake for TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 over an
 * abstract datagram channel. The owner supplies an `output` callback to send
 * datagrams and feeds inbound datagrams to `handlePacket`. On success the
 * connection emits 'connect'; application records arrive via 'data' and are
 * sent via `send`.
 *
 * Scope: one cipher suite, secp256r1, ECDSA P-256 certificates, extended
 * master secret. This is the subset Chromium/Firefox negotiate for data
 * channels, so it interoperates with browsers while staying pure-Node.
 *
 * References: RFC 6347 (DTLS 1.2), RFC 5246 (TLS 1.2), RFC 7627 (EMS),
 * RFC 8422 (ECC cipher suites), RFC 5288 (AES-GCM).
 */

'use strict';

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as P from './protocol';
import { prf } from './prf';
import * as cipher from './cipher';
import * as x509 from '../crypto/x509';

const HANDSHAKE_TIMEOUT_MS = 1000; // initial retransmit timer (doubles per RFC 6347)
const MAX_RETRANSMITS = 10;
const MAX_FRAGMENT = 1200; // keep handshake fragments inside a typical MTU

const ROLE = Object.freeze({ CLIENT: 'client', SERVER: 'server' });

const STATE = Object.freeze({
  NEW: 'new',
  HANDSHAKING: 'handshaking',
  CONNECTED: 'connected',
  CLOSED: 'closed',
  FAILED: 'failed',
});

/** A certificate fingerprint as advertised in SDP a=fingerprint. */
interface Fingerprint {
  algorithm: string;
  value: string;
}

/** Callback used to verify the peer's certificate fingerprint. */
type VerifyFingerprint = (
  fp: Fingerprint,
  remoteCertDer: Buffer
) => boolean;

/** Constructor options for {@link DtlsConnection}. */
interface DtlsConnectionOptions {
  /** 'client' | 'server' */
  role: string;
  /** local DER certificate */
  certDer: Buffer;
  /** local EC private key */
  privateKey: crypto.KeyObject;
  /** called with the peer cert fingerprint; return false to reject. */
  verifyFingerprint?: VerifyFingerprint;
  /** send a datagram to the peer */
  output: (datagram: Buffer) => void;
}

/** A handshake message queued for sending: a type plus its body. */
interface HandshakeMessage {
  type: number;
  body: Buffer;
}

/** A record-layer datagram queued in the current flight. */
interface FlightDatagram {
  type: number;
  payload: Buffer;
}

/** State for reassembling a fragmented inbound handshake message. */
interface ReassemblyEntry {
  type: number;
  length: number;
  data: Buffer;
  received: number;
  ranges: Array<[number, number]>;
}

/**
 * @class DtlsConnection
 * @extends EventEmitter
 */
class DtlsConnection extends EventEmitter {
  role: string;
  state: string;

  #certDer: Buffer;
  #privateKey: crypto.KeyObject;
  #verifyFingerprint: VerifyFingerprint | null;
  #output: (datagram: Buffer) => void;

  // Record layer state.
  #sendEpoch: number;
  #sendSeq: number;
  #handshakeMessageSeq: number;

  // Cipher state (set after key derivation).
  #writeCipher: cipher.GcmCipher | null;
  #readCipher: cipher.GcmCipher | null;
  #sendEncrypted: boolean;

  // Handshake crypto material.
  #clientRandom: Buffer | null;
  #serverRandom: Buffer | null;
  #cookie: Buffer;
  #ecdh: crypto.ECDH | null;
  #masterSecret: Buffer | null;
  #remoteCertDer: Buffer | null;
  #remoteEcdhePub: Buffer | null;
  #useExtendedMasterSecret: boolean;

  #transcript: Buffer[];

  #reassembly: Map<number, ReassemblyEntry>;
  #nextExpectedHsSeq: number;

  #lastFlight: FlightDatagram[];
  #retransmitTimer: NodeJS.Timeout | null;
  #retransmitCount: number;

  #handshakeDone: boolean;

  #cookieSecret?: Buffer;
  #renegRequested?: boolean;

  // Client role: true once the server sent a CertificateRequest. WebRTC peers
  // always do (mutual auth); a TURN-over-DTLS server (coturn) does not, so we
  // must then omit our Certificate / CertificateVerify per TLS.
  #certRequested: boolean;

  // Client role: the encoded first (cookieless) ClientHello. When the server
  // skips HelloVerifyRequest (browsers do, for data channels), this message is
  // the one that belongs in the transcript — see #clientHandle SERVER_HELLO.
  #firstClientHello: Buffer | null = null;

  /**
   * @param opts connection options
   */
  constructor(opts: DtlsConnectionOptions) {
    super();
    this.role = opts.role;
    this.#certDer = opts.certDer;
    this.#privateKey = opts.privateKey;
    this.#verifyFingerprint = opts.verifyFingerprint || null;
    this.#output = opts.output;

    this.state = STATE.NEW;

    // Record layer state.
    this.#sendEpoch = 0;
    this.#sendSeq = 0; // 48-bit record seq within current epoch
    this.#handshakeMessageSeq = 0;

    // Cipher state (set after key derivation).
    this.#writeCipher = null; // GcmCipher for our outbound epoch-1 records
    this.#readCipher = null; // GcmCipher for inbound epoch-1 records
    this.#sendEncrypted = false; // becomes true after we send ChangeCipherSpec

    // Handshake crypto material.
    this.#clientRandom = null;
    this.#serverRandom = null;
    this.#cookie = Buffer.alloc(0);
    this.#ecdh = null; // local ECDH keypair
    this.#masterSecret = null;
    this.#remoteCertDer = null;
    this.#remoteEcdhePub = null; // peer ECDHE public point (server role)
    this.#useExtendedMasterSecret = false;

    // Transcript of handshake messages (DTLS 12-byte header + body), used for
    // Finished / CertificateVerify / EMS. Excludes HelloVerifyRequest and the
    // first (cookieless) ClientHello, per RFC 6347.
    this.#transcript = [];

    // Reassembly of inbound fragmented handshake messages, keyed by msg seq.
    this.#reassembly = new Map();
    this.#nextExpectedHsSeq = 0;

    // Last flight we sent, for retransmission.
    this.#lastFlight = [];
    this.#retransmitTimer = null;
    this.#retransmitCount = 0;

    this.#handshakeDone = false;
    this.#certRequested = false;
  }

  /** Begin the handshake (client sends the first flight). */
  start(): void {
    if (this.state !== STATE.NEW) return;
    this.state = STATE.HANDSHAKING;
    if (this.role === ROLE.CLIENT) {
      this.#clientRandom = this.#makeRandom();
      this.#sendClientHello();
    }
    // Server waits for ClientHello.
  }

  /** 32-byte Random (4-byte gmt_unix_time || 28 random). */
  #makeRandom(): Buffer {
    const r = crypto.randomBytes(32);
    r.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
    return r;
  }

  // ---- Outbound record/handshake plumbing ---------------------------------

  /**
   * Emit a set of handshake messages as one flight: fragment, frame as records,
   * append to transcript, and arm retransmission.
   * @param messages
   */
  #sendFlight(messages: HandshakeMessage[]): void {
    const datagrams: FlightDatagram[] = [];
    for (const msg of messages) {
      const seq = this.#handshakeMessageSeq++;
      // Full (unfragmented) message goes into the transcript hash.
      const full = P.encodeHandshake(msg.type, seq, msg.body);
      this.#transcript.push(full);

      // Fragment the handshake body across records if large.
      const total = msg.body.length;
      let offset = 0;
      do {
        const chunk = msg.body.slice(offset, offset + MAX_FRAGMENT);
        const hdr = Buffer.alloc(12);
        hdr.writeUInt8(msg.type, 0);
        P.uint24(total).copy(hdr, 1);
        hdr.writeUInt16BE(seq, 4);
        P.uint24(offset).copy(hdr, 6);
        P.uint24(chunk.length).copy(hdr, 9);
        const fragment = Buffer.concat([hdr, chunk]);
        datagrams.push({ type: P.CONTENT_TYPE.HANDSHAKE, payload: fragment });
        offset += chunk.length;
      } while (offset < total);
    }

    this.#lastFlight = datagrams;
    this.#retransmitCount = 0;
    this.#flushFlight();
    this.#armRetransmit();
  }

  /** Encode each queued message as a record and send. */
  #flushFlight(): void {
    for (const d of this.#lastFlight) {
      this.#sendRecord(d.type, d.payload);
    }
  }

  /** Send a ChangeCipherSpec record (epoch boundary on our side). */
  #sendChangeCipherSpec(): void {
    this.#sendRecord(P.CONTENT_TYPE.CHANGE_CIPHER_SPEC, Buffer.from([1]));
    // After CCS, subsequent records use the new epoch and are encrypted.
    this.#sendEpoch = 1;
    this.#sendSeq = 0;
    this.#sendEncrypted = true;
  }

  /**
   * Frame a payload as a DTLS record, encrypting if we're past CCS.
   * @param type
   * @param payload
   */
  #sendRecord(type: number, payload: Buffer): void {
    let fragment = payload;
    const seq = this.#sendSeq++;
    if (this.#sendEncrypted && this.#writeCipher) {
      fragment = this.#writeCipher.encrypt(this.#sendEpoch, seq, type, P.DTLS_1_2, payload);
    }
    const record = P.encodeRecord(type, this.#sendEpoch, seq, fragment, P.DTLS_1_2);
    this.#output(record);
  }

  #armRetransmit(): void {
    this.#clearRetransmit();
    this.#retransmitTimer = setTimeout(() => {
      if (this.#handshakeDone || this.state !== STATE.HANDSHAKING) return;
      if (this.#retransmitCount >= MAX_RETRANSMITS) {
        this.#fail(new Error('DTLS handshake timed out'));
        return;
      }
      this.#retransmitCount++;
      this.#flushFlight();
      // Exponential backoff.
      this.#armRetransmit();
    }, HANDSHAKE_TIMEOUT_MS * Math.pow(2, this.#retransmitCount));
    // A pending retransmit must not, by itself, keep the process alive.
    if (this.#retransmitTimer.unref) this.#retransmitTimer.unref();
  }

  #clearRetransmit(): void {
    if (this.#retransmitTimer) {
      clearTimeout(this.#retransmitTimer);
      this.#retransmitTimer = null;
    }
  }

  // ---- Inbound ------------------------------------------------------------

  /**
   * Feed an inbound datagram (one UDP packet, possibly several records).
   * @param packet
   */
  handlePacket(packet: Buffer): void {
    if (this.state === STATE.CLOSED || this.state === STATE.FAILED) return;
    let records: P.Record[];
    try {
      records = P.parseRecords(packet);
    } catch (err) {
      return; // ignore malformed datagrams
    }
    for (const rec of records) {
      try {
        this.#handleRecord(rec);
      } catch (err) {
        this.#fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }

  #handleRecord(rec: P.Record): void {
    let fragment = rec.fragment;

    // Decrypt records from the peer's encrypted epoch.
    if (rec.epoch >= 1) {
      if (!this.#readCipher) {
        // Can't decrypt yet (keys not derived) — drop.
        return;
      }
      fragment = this.#readCipher.decrypt(rec.epoch, rec.seq, rec.type, rec.version, rec.fragment);
    }

    switch (rec.type) {
      case P.CONTENT_TYPE.HANDSHAKE:
        this.#handleHandshakeFragment(fragment);
        break;
      case P.CONTENT_TYPE.CHANGE_CIPHER_SPEC:
        // Peer switched to its encrypted epoch; records now carry epoch 1,
        // which _handleRecord already routes through the read cipher.
        break;
      case P.CONTENT_TYPE.APPLICATION_DATA:
        if (this.state === STATE.CONNECTED) this.emit('data', fragment);
        break;
      case P.CONTENT_TYPE.ALERT:
        this.#handleAlert(fragment);
        break;
      default:
        break;
    }
  }

  #handleAlert(fragment: Buffer): void {
    if (fragment.length < 2) return;
    const level = fragment[0]!;
    const desc = fragment[1]!;
    if (desc === P.ALERT_DESC.CLOSE_NOTIFY) {
      this.close();
    } else if (level === P.ALERT_LEVEL.FATAL) {
      this.#fail(new Error(`DTLS fatal alert: ${desc}`));
    }
  }

  /**
   * Reassemble a (possibly fragmented) handshake message, then dispatch
   * complete messages in order.
   * @param buf - one handshake fragment (12-byte header + chunk)
   */
  #handleHandshakeFragment(buf: Buffer): void {
    const h = P.parseHandshake(buf);

    // Initialize / fetch reassembly buffer for this message_seq.
    let entry = this.#reassembly.get(h.messageSeq);
    if (!entry) {
      entry = { type: h.msgType, length: h.length, data: Buffer.alloc(h.length), received: 0, ranges: [] };
      this.#reassembly.set(h.messageSeq, entry);
    }
    // Copy this fragment into place (ignore duplicates/overlap simply).
    h.body.copy(entry.data, h.fragmentOffset);
    entry.received = Math.max(entry.received, h.fragmentOffset + h.fragmentLength);

    // Dispatch any in-order, fully-received messages.
    while (true) {
      const next = this.#reassembly.get(this.#nextExpectedHsSeq);
      if (!next || next.received < next.length) break;
      this.#reassembly.delete(this.#nextExpectedHsSeq);
      this.#nextExpectedHsSeq++;
      this.#dispatchHandshake(next.type, next.data);
    }
  }

  /**
   * Add a received handshake message to the transcript (reconstructed as a
   * single unfragmented message, per RFC 6347 §4.2.6).
   */
  #appendInboundTranscript(type: number, body: Buffer): void {
    const seq = this.#nextExpectedHsSeq - 1; // message_seq just consumed
    this.#transcript.push(P.encodeHandshake(type, seq, body));
  }

  #dispatchHandshake(type: number, body: Buffer): void {
    if (this.role === ROLE.CLIENT) {
      this.#clientHandle(type, body);
    } else {
      this.#serverHandle(type, body);
    }
  }

  #transcriptHash(): Buffer {
    const h = crypto.createHash('sha256');
    for (const m of this.#transcript) h.update(m);
    return h.digest();
  }

  /** Raw concatenation of all transcript handshake messages (for signing). */
  #transcriptBytes(): Buffer {
    return Buffer.concat(this.#transcript);
  }

  // ---- CLIENT role --------------------------------------------------------

  #sendClientHello(): void {
    const body = this.#buildClientHello();
    if (this.#cookie.length === 0) {
      // First ClientHello is excluded from the transcript: send as a raw
      // handshake record without recording it, and without retransmit arming
      // beyond the cookie exchange.
      const seq = this.#handshakeMessageSeq++; // message_seq 0
      const fragment = P.encodeHandshake(P.HANDSHAKE_TYPE.CLIENT_HELLO, seq, body);
      // Remember it: if the server skips HelloVerifyRequest (browsers do), this
      // is the ClientHello that must go into the transcript, with message_seq 0.
      this.#firstClientHello = fragment;
      this.#lastFlight = [{ type: P.CONTENT_TYPE.HANDSHAKE, payload: fragment }];
      this.#flushFlight();
      this.#armRetransmit();
    } else {
      // Second ClientHello (with cookie) starts the real transcript.
      // It reuses message_seq = 1.
      const seq = this.#handshakeMessageSeq++; // message_seq 1
      const full = P.encodeHandshake(P.HANDSHAKE_TYPE.CLIENT_HELLO, seq, body);
      this.#transcript.push(full);
      this.#lastFlight = [{ type: P.CONTENT_TYPE.HANDSHAKE, payload: full }];
      this.#retransmitCount = 0;
      this.#flushFlight();
      this.#armRetransmit();
    }
  }

  #buildClientHello(): Buffer {
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0xfe, 0xfd])); // client_version DTLS 1.2
    parts.push(this.#clientRandom!);
    parts.push(P.vec8(Buffer.alloc(0))); // session_id (empty)
    parts.push(P.vec8(this.#cookie)); // cookie
    // cipher_suites
    const cs = Buffer.alloc(2);
    cs.writeUInt16BE(P.CIPHER_SUITE, 0);
    parts.push(P.vec16(cs));
    // compression_methods: null only
    parts.push(P.vec8(Buffer.from([0x00])));
    // extensions
    parts.push(P.vec16(this.#buildClientExtensions()));
    return Buffer.concat(parts);
  }

  #buildClientExtensions(): Buffer {
    const exts: Buffer[] = [];

    // supported_groups: secp256r1
    const groups = Buffer.alloc(2);
    groups.writeUInt16BE(P.NAMED_GROUP.secp256r1, 0);
    exts.push(this.#ext(P.EXTENSION.SUPPORTED_GROUPS, P.vec16(groups)));

    // ec_point_formats: uncompressed
    exts.push(this.#ext(P.EXTENSION.EC_POINT_FORMATS, P.vec8(Buffer.from([P.EC_POINT_FORMAT.uncompressed]))));

    // signature_algorithms: ecdsa_secp256r1_sha256
    const sigalgs = Buffer.from([P.HASH_ALG.sha256, P.SIG_ALG.ecdsa]);
    exts.push(this.#ext(P.EXTENSION.SIGNATURE_ALGORITHMS, P.vec16(sigalgs)));

    // extended_master_secret (empty)
    exts.push(this.#ext(P.EXTENSION.EXTENDED_MASTER_SECRET, Buffer.alloc(0)));

    return Buffer.concat(exts);
  }

  #ext(type: number, body: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(body.length, 2);
    return Buffer.concat([head, body]);
  }

  #clientHandle(type: number, body: Buffer): void {
    switch (type) {
      case P.HANDSHAKE_TYPE.HELLO_VERIFY_REQUEST: {
        // Extract cookie and resend ClientHello. Not added to transcript.
        // body: server_version(2) || cookie<0..255>
        const cookieLen = body.readUInt8(2);
        this.#cookie = body.slice(3, 3 + cookieLen);
        this.#clearRetransmit();
        // Reset message seq: RFC 6347 — second ClientHello has message_seq 1.
        this.#sendClientHello();
        break;
      }
      case P.HANDSHAKE_TYPE.SERVER_HELLO:
        // If the server skipped HelloVerifyRequest (no cookie exchange — what
        // browsers do for data-channel DTLS), our first ClientHello was never
        // recorded. Per RFC 6347 §4.2.1 it belongs in the transcript in that
        // case, so prepend it now, before ServerHello, or our CertificateVerify
        // signature and Finished MAC will be computed over the wrong transcript
        // and the peer rejects them with decrypt_error (alert 51).
        if (this.#cookie.length === 0 && this.#transcript.length === 0 && this.#firstClientHello) {
          this.#transcript.push(this.#firstClientHello);
        }
        this.#appendInboundTranscript(type, body);
        this.#parseServerHello(body);
        break;
      case P.HANDSHAKE_TYPE.CERTIFICATE:
        this.#appendInboundTranscript(type, body);
        this.#remoteCertDer = this.#parseCertificate(body);
        break;
      case P.HANDSHAKE_TYPE.SERVER_KEY_EXCHANGE:
        this.#appendInboundTranscript(type, body);
        this.#parseServerKeyExchange(body);
        break;
      case P.HANDSHAKE_TYPE.CERTIFICATE_REQUEST:
        // The server wants us to authenticate (WebRTC is mutual-auth). Record
        // that so the second flight includes our Certificate/CertificateVerify;
        // a server that omits this (e.g. coturn over DTLS) leaves the flag false
        // and we skip them. Either way fold the message into the transcript.
        this.#certRequested = true;
        this.#appendInboundTranscript(type, body);
        break;
      case P.HANDSHAKE_TYPE.SERVER_HELLO_DONE:
        this.#appendInboundTranscript(type, body);
        this.#clearRetransmit();
        this.#sendClientSecondFlight();
        break;
      case P.HANDSHAKE_TYPE.FINISHED:
        this.#verifyPeerFinished(body, P.FINISHED_LABEL.SERVER);
        this.#appendInboundTranscript(type, body);
        this.#onHandshakeComplete();
        break;
      default:
        break;
    }
  }

  #parseServerHello(body: Buffer): void {
    // server_version(2) || random(32) || session_id<vec8> || cipher_suite(2)
    // || compression(1) || extensions<vec16>
    let o = 2;
    this.#serverRandom = body.slice(o, o + 32);
    o += 32;
    const sidLen = body.readUInt8(o);
    o += 1 + sidLen;
    const suite = body.readUInt16BE(o);
    o += 2;
    if (suite !== P.CIPHER_SUITE) {
      throw new Error(`Server chose unsupported cipher suite 0x${suite.toString(16)}`);
    }
    o += 1; // compression
    // Parse extensions for extended_master_secret.
    if (o + 2 <= body.length) {
      const extLen = body.readUInt16BE(o);
      o += 2;
      const end = o + extLen;
      while (o + 4 <= end) {
        const etype = body.readUInt16BE(o);
        const elen = body.readUInt16BE(o + 2);
        o += 4;
        if (etype === P.EXTENSION.EXTENDED_MASTER_SECRET) {
          this.#useExtendedMasterSecret = true;
        }
        o += elen;
      }
    }
  }

  #sendClientSecondFlight(): void {
    // Generate our ECDHE key.
    this.#ecdh = crypto.createECDH('prime256v1');
    this.#ecdh.generateKeys();
    const clientPub = this.#ecdh.getPublicKey(); // uncompressed point (65 bytes)

    // Compute pre-master secret = ECDH(serverPub).
    const pms = this.#ecdh.computeSecret(this.#remoteEcdhePub!);

    // ClientKeyExchange: ECPoint as vec8.
    const cke = P.vec8(clientPub);

    // Whether we authenticate to the peer. WebRTC servers always send a
    // CertificateRequest; a TURN-over-DTLS server (coturn) does not, in which
    // case we send neither Certificate nor CertificateVerify.
    const sendCert = this.#certRequested;

    // Build the messages we're about to send so the transcript is correct for
    // the master secret (EMS hashes through ClientKeyExchange) and, when we
    // authenticate, for CertificateVerify (which signs through ClientKeyExchange).
    // Certificate, when present, precedes ClientKeyExchange in the message_seq.
    let certMsg: Buffer | null = null;
    let certFull: Buffer = Buffer.alloc(0);
    const ckeSeq = sendCert ? this.#handshakeMessageSeq + 1 : this.#handshakeMessageSeq;
    if (sendCert) {
      certMsg = this.#buildCertificateMessage();
      certFull = P.encodeHandshake(P.HANDSHAKE_TYPE.CERTIFICATE, this.#handshakeMessageSeq, certMsg);
    }
    const ckeFull = P.encodeHandshake(P.HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE, ckeSeq, cke);

    // Master secret derivation. The EMS session hash covers the transcript
    // through ClientKeyExchange (including our Certificate when we send one).
    if (this.#useExtendedMasterSecret) {
      const h = crypto.createHash('sha256');
      for (const m of this.#transcript) h.update(m);
      if (sendCert) h.update(certFull);
      h.update(ckeFull);
      const sessionHash = h.digest();
      this.#masterSecret = cipher.deriveExtendedMasterSecret(pms, sessionHash);
    } else {
      this.#masterSecret = cipher.deriveMasterSecret(pms, this.#clientRandom!, this.#serverRandom!);
    }
    this.#deriveCipherKeys();

    // Flight: Certificate (if requested), ClientKeyExchange, CertificateVerify
    // (if requested). _sendFlight records each into the transcript.
    const flight: HandshakeMessage[] = [];
    if (sendCert) flight.push({ type: P.HANDSHAKE_TYPE.CERTIFICATE, body: certMsg! });
    flight.push({ type: P.HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE, body: cke });
    if (sendCert) {
      // CertificateVerify: sign the raw handshake transcript through
      // ClientKeyExchange. crypto.sign applies SHA-256 itself, so we feed it the
      // concatenated messages, not a pre-computed digest.
      const cvData = Buffer.concat([...this.#transcript, certFull, ckeFull]);
      const cvSig = crypto.sign('sha256', cvData, { key: this.#privateKey, dsaEncoding: 'der' });
      const cvBody = Buffer.concat([
        Buffer.from([P.HASH_ALG.sha256, P.SIG_ALG.ecdsa]),
        P.vec16(cvSig),
      ]);
      flight.push({ type: P.HANDSHAKE_TYPE.CERTIFICATE_VERIFY, body: cvBody });
    }
    this.#sendFlight(flight);

    this.#sendChangeCipherSpec();
    this.#sendFinished(P.FINISHED_LABEL.CLIENT);
  }

  // ---- SERVER role --------------------------------------------------------

  #serverHandle(type: number, body: Buffer): void {
    switch (type) {
      case P.HANDSHAKE_TYPE.CLIENT_HELLO:
        this.#handleClientHello(body);
        break;
      case P.HANDSHAKE_TYPE.CERTIFICATE:
        this.#appendInboundTranscript(type, body);
        this.#remoteCertDer = this.#parseCertificate(body);
        break;
      case P.HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE: {
        this.#appendInboundTranscript(type, body);
        const pubLen = body.readUInt8(0);
        this.#remoteEcdhePub = body.slice(1, 1 + pubLen);
        const pms = this.#ecdh!.computeSecret(this.#remoteEcdhePub);
        if (this.#useExtendedMasterSecret) {
          this.#masterSecret = cipher.deriveExtendedMasterSecret(pms, this.#transcriptHash());
        } else {
          this.#masterSecret = cipher.deriveMasterSecret(pms, this.#clientRandom!, this.#serverRandom!);
        }
        this.#deriveCipherKeys();
        break;
      }
      case P.HANDSHAKE_TYPE.CERTIFICATE_VERIFY:
        this.#verifyClientCertificateVerify(body);
        this.#appendInboundTranscript(type, body);
        break;
      case P.HANDSHAKE_TYPE.FINISHED:
        this.#verifyPeerFinished(body, P.FINISHED_LABEL.CLIENT);
        this.#appendInboundTranscript(type, body);
        // Server responds with its own CCS + Finished.
        this.#sendChangeCipherSpec();
        this.#sendFinished(P.FINISHED_LABEL.SERVER);
        this.#onHandshakeComplete();
        break;
      default:
        break;
    }
  }

  #handleClientHello(body: Buffer): void {
    // Parse enough to extract random, cookie, and extensions.
    let o = 2; // skip client_version
    const random = body.slice(o, o + 32);
    o += 32;
    const sidLen = body.readUInt8(o);
    o += 1 + sidLen;
    const cookieLen = body.readUInt8(o);
    const cookie = body.slice(o + 1, o + 1 + cookieLen);
    o += 1 + cookieLen;
    const csLen = body.readUInt16BE(o);
    const cipherSuites = body.slice(o + 2, o + 2 + csLen);
    o += 2 + csLen;
    const compLen = body.readUInt8(o);
    o += 1 + compLen;
    // Extensions
    let emsRequested = false;
    // Secure renegotiation (RFC 5746): the client signals support via the
    // renegotiation_info extension or the SCSV cipher (0x00FF). OpenSSL 3.x
    // requires the server to acknowledge it, or it aborts with
    // handshake_failure; older OpenSSL and browsers tolerate its absence.
    let renegRequested = false;
    for (let i = 0; i + 1 < cipherSuites.length; i += 2) {
      if (cipherSuites.readUInt16BE(i) === 0x00ff) renegRequested = true;
    }
    if (o + 2 <= body.length) {
      const extLen = body.readUInt16BE(o);
      o += 2;
      const end = o + extLen;
      while (o + 4 <= end) {
        const etype = body.readUInt16BE(o);
        const elen = body.readUInt16BE(o + 2);
        o += 4;
        if (etype === P.EXTENSION.EXTENDED_MASTER_SECRET) emsRequested = true;
        if (etype === P.EXTENSION.RENEGOTIATION_INFO) renegRequested = true;
        o += elen;
      }
    }
    this.#renegRequested = renegRequested;

    if (cookie.length === 0) {
      // Stateless cookie exchange: reply with HelloVerifyRequest. Not part of
      // the transcript, and we do not yet commit any state.
      this.#clientRandom = random;
      this.#sendHelloVerifyRequest(this.#makeCookie(random));
      // The client resends ClientHello as message_seq 1; expect that next.
      this.#reassembly.clear();
      this.#nextExpectedHsSeq = 1;
      return;
    }

    // Validate cookie.
    const expected = this.#makeCookie(random);
    if (!cookie.equals(expected)) {
      // Tolerate by just re-issuing HVR.
      this.#sendHelloVerifyRequest(expected);
      this.#reassembly.clear();
      this.#nextExpectedHsSeq = 1;
      return;
    }

    // Cookie OK — this ClientHello starts the transcript.
    this.#clientRandom = random;
    this.#useExtendedMasterSecret = emsRequested;
    this.#appendInboundTranscript(P.HANDSHAKE_TYPE.CLIENT_HELLO, body);
    this.#sendServerFlight();
  }

  #makeCookie(clientRandom: Buffer): Buffer {
    if (!this.#cookieSecret) this.#cookieSecret = crypto.randomBytes(32);
    return crypto.createHmac('sha256', this.#cookieSecret).update(clientRandom).digest().slice(0, 20);
  }

  #sendHelloVerifyRequest(cookie: Buffer): void {
    // body: server_version(2) || cookie<vec8>
    const body = Buffer.concat([Buffer.from([0xfe, 0xff]), P.vec8(cookie)]);
    // HVR uses message_seq 0 and is not retransmitted via flight machinery.
    const fragment = P.encodeHandshake(P.HANDSHAKE_TYPE.HELLO_VERIFY_REQUEST, 0, body);
    this.#sendRecord(P.CONTENT_TYPE.HANDSHAKE, fragment);
    // Server-side handshake message seq for the real flight starts at 1.
    this.#handshakeMessageSeq = 1;
  }

  #sendServerFlight(): void {
    this.#serverRandom = this.#makeRandom();
    this.#ecdh = crypto.createECDH('prime256v1');
    this.#ecdh.generateKeys();
    const serverPub = this.#ecdh.getPublicKey();

    // ServerHello
    const shBody = this.#buildServerHello();

    // Certificate
    const certMsg = this.#buildCertificateMessage();

    // ServerKeyExchange: ServerECDHParams + signature
    const ecdhParams = Buffer.concat([
      Buffer.from([0x03]), // curve_type = named_curve
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(P.NAMED_GROUP.secp256r1, 0); return b; })(),
      P.vec8(serverPub),
    ]);
    const signed = Buffer.concat([this.#clientRandom!, this.#serverRandom, ecdhParams]);
    const sig = crypto.sign('sha256', signed, { key: this.#privateKey, dsaEncoding: 'der' });
    const skeBody = Buffer.concat([
      ecdhParams,
      Buffer.from([P.HASH_ALG.sha256, P.SIG_ALG.ecdsa]),
      P.vec16(sig),
    ]);

    // CertificateRequest: ask client for an ECDSA cert (WebRTC is mutual-auth).
    const certTypes = P.vec8(Buffer.from([P.CERT_TYPE.ecdsa_sign, P.CERT_TYPE.rsa_sign]));
    const sigAlgs = P.vec16(Buffer.from([P.HASH_ALG.sha256, P.SIG_ALG.ecdsa]));
    const cas = P.vec16(Buffer.alloc(0));
    const crBody = Buffer.concat([certTypes, sigAlgs, cas]);

    // ServerHelloDone
    const shdBody = Buffer.alloc(0);

    this.#sendFlight([
      { type: P.HANDSHAKE_TYPE.SERVER_HELLO, body: shBody },
      { type: P.HANDSHAKE_TYPE.CERTIFICATE, body: certMsg },
      { type: P.HANDSHAKE_TYPE.SERVER_KEY_EXCHANGE, body: skeBody },
      { type: P.HANDSHAKE_TYPE.CERTIFICATE_REQUEST, body: crBody },
      { type: P.HANDSHAKE_TYPE.SERVER_HELLO_DONE, body: shdBody },
    ]);
  }

  #buildServerHello(): Buffer {
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0xfe, 0xfd])); // server_version DTLS 1.2
    parts.push(this.#serverRandom!);
    parts.push(P.vec8(Buffer.alloc(0))); // session_id empty
    const cs = Buffer.alloc(2);
    cs.writeUInt16BE(P.CIPHER_SUITE, 0);
    parts.push(cs); // cipher_suite (2 bytes, not a vector)
    parts.push(Buffer.from([0x00])); // compression null
    // extensions
    const exts: Buffer[] = [];
    if (this.#useExtendedMasterSecret) {
      exts.push(this.#ext(P.EXTENSION.EXTENDED_MASTER_SECRET, Buffer.alloc(0)));
    }
    exts.push(this.#ext(P.EXTENSION.EC_POINT_FORMATS, P.vec8(Buffer.from([P.EC_POINT_FORMAT.uncompressed]))));
    // Acknowledge secure renegotiation with an empty renegotiated_connection
    // (a 1-byte zero-length vector). Required by OpenSSL 3.x clients.
    if (this.#renegRequested) {
      exts.push(this.#ext(P.EXTENSION.RENEGOTIATION_INFO, P.vec8(Buffer.alloc(0))));
    }
    parts.push(P.vec16(Buffer.concat(exts)));
    return Buffer.concat(parts);
  }

  #verifyClientCertificateVerify(body: Buffer): void {
    // body: SignatureAndHashAlgorithm(2) || signature<vec16>
    const sigLen = body.readUInt16BE(2);
    const sig = body.slice(4, 4 + sigLen);
    // Verify over the raw transcript through ClientKeyExchange (crypto.verify
    // hashes internally, mirroring the signer).
    const data = this.#transcriptBytes();
    const pub = this.#publicKeyFromCert(this.#remoteCertDer!);
    const ok = crypto.verify('sha256', data, { key: pub, dsaEncoding: 'der' }, sig);
    if (!ok) throw new Error('Client CertificateVerify signature invalid');
  }

  // ---- Shared handshake helpers ------------------------------------------

  /** Build a Certificate message carrying our single DER cert. */
  #buildCertificateMessage(): Buffer {
    // certificate_list: each entry is cert<vec24>; whole list is vec24.
    const entry = P.vec24(this.#certDer);
    return P.vec24(entry);
  }

  /** Parse a Certificate message and return the first cert's DER. */
  #parseCertificate(body: Buffer): Buffer | null {
    // body: certificate_list<vec24> of cert<vec24>
    const listLen = P.readUint24(body, 0);
    let o = 3;
    const end = 3 + listLen;
    if (o + 3 > end) {
      // Empty certificate list.
      return null;
    }
    const certLen = P.readUint24(body, o);
    o += 3;
    const certDer = body.slice(o, o + certLen);

    // Fingerprint verification against the SDP-advertised value.
    if (this.#verifyFingerprint) {
      const fp = { algorithm: 'sha-256', value: x509.fingerprint(certDer, 'sha-256') };
      if (!this.#verifyFingerprint(fp, certDer)) {
        throw new Error('Remote certificate fingerprint mismatch');
      }
    }
    return certDer;
  }

  #parseServerKeyExchange(body: Buffer): void {
    // ServerECDHParams: curve_type(1) || named_curve(2) || public<vec8>
    // then SignatureAndHashAlgorithm(2) || signature<vec16>
    let o = 0;
    const curveType = body.readUInt8(o); o += 1;
    const namedCurve = body.readUInt16BE(o); o += 2;
    if (curveType !== 3 || namedCurve !== P.NAMED_GROUP.secp256r1) {
      throw new Error('Unsupported ECDHE curve from server');
    }
    const pubLen = body.readUInt8(o); o += 1;
    const serverPub = body.slice(o, o + pubLen); o += pubLen;
    this.#remoteEcdhePub = serverPub;

    // Verify the signature over client_random || server_random || ECDHParams.
    const ecdhParams = body.slice(0, o);
    // skip SignatureAndHashAlgorithm(2)
    o += 2;
    const sigLen = body.readUInt16BE(o); o += 2;
    const sig = body.slice(o, o + sigLen);
    const signed = Buffer.concat([this.#clientRandom!, this.#serverRandom!, ecdhParams]);
    const pub = this.#publicKeyFromCert(this.#remoteCertDer!);
    const ok = crypto.verify('sha256', signed, { key: pub, dsaEncoding: 'der' }, sig);
    if (!ok) throw new Error('ServerKeyExchange signature invalid');
  }

  #publicKeyFromCert(certDer: Buffer): crypto.KeyObject {
    const cert = new crypto.X509Certificate(certDer);
    return cert.publicKey;
  }

  #deriveCipherKeys(): void {
    const { clientKey, serverKey, clientIV, serverIV } = cipher.deriveKeys(
      this.#masterSecret!,
      this.#clientRandom!,
      this.#serverRandom!
    );
    if (this.role === ROLE.CLIENT) {
      this.#writeCipher = new cipher.GcmCipher(clientKey, clientIV);
      this.#readCipher = new cipher.GcmCipher(serverKey, serverIV);
    } else {
      this.#writeCipher = new cipher.GcmCipher(serverKey, serverIV);
      this.#readCipher = new cipher.GcmCipher(clientKey, clientIV);
    }
  }

  #sendFinished(label: string): void {
    const verifyData = prf(this.#masterSecret!, label, this.#transcriptHash(), 12);
    // Finished is itself a handshake message and goes into the transcript.
    const seq = this.#handshakeMessageSeq++;
    const full = P.encodeHandshake(P.HANDSHAKE_TYPE.FINISHED, seq, verifyData);
    this.#transcript.push(full);
    this.#sendRecord(P.CONTENT_TYPE.HANDSHAKE, full);
  }

  #verifyPeerFinished(body: Buffer, label: string): void {
    const expected = prf(this.#masterSecret!, label, this.#transcriptHash(), 12);
    if (!crypto.timingSafeEqual(body, expected)) {
      throw new Error('Peer Finished verify_data mismatch');
    }
  }

  #onHandshakeComplete(): void {
    if (this.#handshakeDone) return;
    this.#handshakeDone = true;
    this.#clearRetransmit();
    this.state = STATE.CONNECTED;
    this.emit('connect');
  }

  // ---- Application data ----------------------------------------------------

  /**
   * Send application data over the established connection.
   * @param data
   */
  send(data: Buffer): void {
    if (this.state !== STATE.CONNECTED) {
      throw new Error('DTLS connection not established');
    }
    this.#sendRecord(P.CONTENT_TYPE.APPLICATION_DATA, data);
  }

  /** Send a close_notify and tear down. */
  close(): void {
    if (this.state === STATE.CLOSED || this.state === STATE.FAILED) return;
    try {
      if (this.#sendEncrypted) {
        this.#sendRecord(
          P.CONTENT_TYPE.ALERT,
          Buffer.from([P.ALERT_LEVEL.WARNING, P.ALERT_DESC.CLOSE_NOTIFY])
        );
      }
    } catch (_) {
      // best-effort
    }
    this.#clearRetransmit();
    this.state = STATE.CLOSED;
    this.emit('close');
  }

  #fail(err: Error): void {
    if (this.state === STATE.FAILED || this.state === STATE.CLOSED) return;
    this.#clearRetransmit();
    this.state = STATE.FAILED;
    this.emit('error', err);
  }

  /** The peer's certificate DER, available after the handshake. */
  getRemoteCertificate(): Buffer | null {
    return this.#remoteCertDer;
  }
}

export { DtlsConnection, ROLE, STATE };
