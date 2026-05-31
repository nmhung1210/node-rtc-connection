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

  private _certDer: Buffer;
  private _privateKey: crypto.KeyObject;
  private _verifyFingerprint: VerifyFingerprint | null;
  private _output: (datagram: Buffer) => void;

  // Record layer state.
  private _sendEpoch: number;
  private _sendSeq: number;
  private _handshakeMessageSeq: number;

  // Cipher state (set after key derivation).
  private _writeCipher: cipher.GcmCipher | null;
  private _readCipher: cipher.GcmCipher | null;
  private _sendEncrypted: boolean;

  // Handshake crypto material.
  private _clientRandom: Buffer | null;
  private _serverRandom: Buffer | null;
  private _cookie: Buffer;
  private _ecdh: crypto.ECDH | null;
  private _masterSecret: Buffer | null;
  private _remoteCertDer: Buffer | null;
  private _remoteEcdhePub: Buffer | null;
  private _useExtendedMasterSecret: boolean;

  private _transcript: Buffer[];

  private _reassembly: Map<number, ReassemblyEntry>;
  private _nextExpectedHsSeq: number;

  private _lastFlight: FlightDatagram[];
  private _retransmitTimer: NodeJS.Timeout | null;
  private _retransmitCount: number;

  private _handshakeDone: boolean;

  private _cookieSecret?: Buffer;
  private _renegRequested?: boolean;

  /**
   * @param opts connection options
   */
  constructor(opts: DtlsConnectionOptions) {
    super();
    this.role = opts.role;
    this._certDer = opts.certDer;
    this._privateKey = opts.privateKey;
    this._verifyFingerprint = opts.verifyFingerprint || null;
    this._output = opts.output;

    this.state = STATE.NEW;

    // Record layer state.
    this._sendEpoch = 0;
    this._sendSeq = 0; // 48-bit record seq within current epoch
    this._handshakeMessageSeq = 0;

    // Cipher state (set after key derivation).
    this._writeCipher = null; // GcmCipher for our outbound epoch-1 records
    this._readCipher = null; // GcmCipher for inbound epoch-1 records
    this._sendEncrypted = false; // becomes true after we send ChangeCipherSpec

    // Handshake crypto material.
    this._clientRandom = null;
    this._serverRandom = null;
    this._cookie = Buffer.alloc(0);
    this._ecdh = null; // local ECDH keypair
    this._masterSecret = null;
    this._remoteCertDer = null;
    this._remoteEcdhePub = null; // peer ECDHE public point (server role)
    this._useExtendedMasterSecret = false;

    // Transcript of handshake messages (DTLS 12-byte header + body), used for
    // Finished / CertificateVerify / EMS. Excludes HelloVerifyRequest and the
    // first (cookieless) ClientHello, per RFC 6347.
    this._transcript = [];

    // Reassembly of inbound fragmented handshake messages, keyed by msg seq.
    this._reassembly = new Map();
    this._nextExpectedHsSeq = 0;

    // Last flight we sent, for retransmission.
    this._lastFlight = [];
    this._retransmitTimer = null;
    this._retransmitCount = 0;

    this._handshakeDone = false;
  }

  /** Begin the handshake (client sends the first flight). */
  start(): void {
    if (this.state !== STATE.NEW) return;
    this.state = STATE.HANDSHAKING;
    if (this.role === ROLE.CLIENT) {
      this._clientRandom = this._makeRandom();
      this._sendClientHello();
    }
    // Server waits for ClientHello.
  }

  /** 32-byte Random (4-byte gmt_unix_time || 28 random). */
  _makeRandom(): Buffer {
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
  _sendFlight(messages: HandshakeMessage[]): void {
    const datagrams: FlightDatagram[] = [];
    for (const msg of messages) {
      const seq = this._handshakeMessageSeq++;
      // Full (unfragmented) message goes into the transcript hash.
      const full = P.encodeHandshake(msg.type, seq, msg.body);
      this._transcript.push(full);

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

    this._lastFlight = datagrams;
    this._retransmitCount = 0;
    this._flushFlight();
    this._armRetransmit();
  }

  /** Encode each queued message as a record and send. */
  _flushFlight(): void {
    for (const d of this._lastFlight) {
      this._sendRecord(d.type, d.payload);
    }
  }

  /** Send a ChangeCipherSpec record (epoch boundary on our side). */
  _sendChangeCipherSpec(): void {
    this._sendRecord(P.CONTENT_TYPE.CHANGE_CIPHER_SPEC, Buffer.from([1]));
    // After CCS, subsequent records use the new epoch and are encrypted.
    this._sendEpoch = 1;
    this._sendSeq = 0;
    this._sendEncrypted = true;
  }

  /**
   * Frame a payload as a DTLS record, encrypting if we're past CCS.
   * @param type
   * @param payload
   */
  _sendRecord(type: number, payload: Buffer): void {
    let fragment = payload;
    const seq = this._sendSeq++;
    if (this._sendEncrypted && this._writeCipher) {
      fragment = this._writeCipher.encrypt(this._sendEpoch, seq, type, P.DTLS_1_2, payload);
    }
    const record = P.encodeRecord(type, this._sendEpoch, seq, fragment, P.DTLS_1_2);
    this._output(record);
  }

  _armRetransmit(): void {
    this._clearRetransmit();
    this._retransmitTimer = setTimeout(() => {
      if (this._handshakeDone || this.state !== STATE.HANDSHAKING) return;
      if (this._retransmitCount >= MAX_RETRANSMITS) {
        this._fail(new Error('DTLS handshake timed out'));
        return;
      }
      this._retransmitCount++;
      this._flushFlight();
      // Exponential backoff.
      this._armRetransmit();
    }, HANDSHAKE_TIMEOUT_MS * Math.pow(2, this._retransmitCount));
    // A pending retransmit must not, by itself, keep the process alive.
    if (this._retransmitTimer.unref) this._retransmitTimer.unref();
  }

  _clearRetransmit(): void {
    if (this._retransmitTimer) {
      clearTimeout(this._retransmitTimer);
      this._retransmitTimer = null;
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
        this._handleRecord(rec);
      } catch (err) {
        this._fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
  }

  _handleRecord(rec: P.Record): void {
    let fragment = rec.fragment;

    // Decrypt records from the peer's encrypted epoch.
    if (rec.epoch >= 1) {
      if (!this._readCipher) {
        // Can't decrypt yet (keys not derived) — drop.
        return;
      }
      fragment = this._readCipher.decrypt(rec.epoch, rec.seq, rec.type, rec.version, rec.fragment);
    }

    switch (rec.type) {
      case P.CONTENT_TYPE.HANDSHAKE:
        this._handleHandshakeFragment(fragment);
        break;
      case P.CONTENT_TYPE.CHANGE_CIPHER_SPEC:
        // Peer switched to its encrypted epoch; records now carry epoch 1,
        // which _handleRecord already routes through the read cipher.
        break;
      case P.CONTENT_TYPE.APPLICATION_DATA:
        if (this.state === STATE.CONNECTED) this.emit('data', fragment);
        break;
      case P.CONTENT_TYPE.ALERT:
        this._handleAlert(fragment);
        break;
      default:
        break;
    }
  }

  _handleAlert(fragment: Buffer): void {
    if (fragment.length < 2) return;
    const level = fragment[0]!;
    const desc = fragment[1]!;
    if (desc === P.ALERT_DESC.CLOSE_NOTIFY) {
      this.close();
    } else if (level === P.ALERT_LEVEL.FATAL) {
      this._fail(new Error(`DTLS fatal alert: ${desc}`));
    }
  }

  /**
   * Reassemble a (possibly fragmented) handshake message, then dispatch
   * complete messages in order.
   * @param buf - one handshake fragment (12-byte header + chunk)
   */
  _handleHandshakeFragment(buf: Buffer): void {
    const h = P.parseHandshake(buf);

    // Initialize / fetch reassembly buffer for this message_seq.
    let entry = this._reassembly.get(h.messageSeq);
    if (!entry) {
      entry = { type: h.msgType, length: h.length, data: Buffer.alloc(h.length), received: 0, ranges: [] };
      this._reassembly.set(h.messageSeq, entry);
    }
    // Copy this fragment into place (ignore duplicates/overlap simply).
    h.body.copy(entry.data, h.fragmentOffset);
    entry.received = Math.max(entry.received, h.fragmentOffset + h.fragmentLength);

    // Dispatch any in-order, fully-received messages.
    while (true) {
      const next = this._reassembly.get(this._nextExpectedHsSeq);
      if (!next || next.received < next.length) break;
      this._reassembly.delete(this._nextExpectedHsSeq);
      this._nextExpectedHsSeq++;
      this._dispatchHandshake(next.type, next.data);
    }
  }

  /**
   * Add a received handshake message to the transcript (reconstructed as a
   * single unfragmented message, per RFC 6347 §4.2.6).
   */
  _appendInboundTranscript(type: number, body: Buffer): void {
    const seq = this._nextExpectedHsSeq - 1; // message_seq just consumed
    this._transcript.push(P.encodeHandshake(type, seq, body));
  }

  _dispatchHandshake(type: number, body: Buffer): void {
    if (this.role === ROLE.CLIENT) {
      this._clientHandle(type, body);
    } else {
      this._serverHandle(type, body);
    }
  }

  _transcriptHash(): Buffer {
    const h = crypto.createHash('sha256');
    for (const m of this._transcript) h.update(m);
    return h.digest();
  }

  /** Raw concatenation of all transcript handshake messages (for signing). */
  _transcriptBytes(): Buffer {
    return Buffer.concat(this._transcript);
  }

  // ---- CLIENT role --------------------------------------------------------

  _sendClientHello(): void {
    const body = this._buildClientHello();
    if (this._cookie.length === 0) {
      // First ClientHello is excluded from the transcript: send as a raw
      // handshake record without recording it, and without retransmit arming
      // beyond the cookie exchange.
      const seq = this._handshakeMessageSeq++; // message_seq 0
      const fragment = P.encodeHandshake(P.HANDSHAKE_TYPE.CLIENT_HELLO, seq, body);
      this._lastFlight = [{ type: P.CONTENT_TYPE.HANDSHAKE, payload: fragment }];
      this._flushFlight();
      this._armRetransmit();
    } else {
      // Second ClientHello (with cookie) starts the real transcript.
      // It reuses message_seq = 1.
      const seq = this._handshakeMessageSeq++; // message_seq 1
      const full = P.encodeHandshake(P.HANDSHAKE_TYPE.CLIENT_HELLO, seq, body);
      this._transcript.push(full);
      this._lastFlight = [{ type: P.CONTENT_TYPE.HANDSHAKE, payload: full }];
      this._retransmitCount = 0;
      this._flushFlight();
      this._armRetransmit();
    }
  }

  _buildClientHello(): Buffer {
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0xfe, 0xfd])); // client_version DTLS 1.2
    parts.push(this._clientRandom!);
    parts.push(P.vec8(Buffer.alloc(0))); // session_id (empty)
    parts.push(P.vec8(this._cookie)); // cookie
    // cipher_suites
    const cs = Buffer.alloc(2);
    cs.writeUInt16BE(P.CIPHER_SUITE, 0);
    parts.push(P.vec16(cs));
    // compression_methods: null only
    parts.push(P.vec8(Buffer.from([0x00])));
    // extensions
    parts.push(P.vec16(this._buildClientExtensions()));
    return Buffer.concat(parts);
  }

  _buildClientExtensions(): Buffer {
    const exts: Buffer[] = [];

    // supported_groups: secp256r1
    const groups = Buffer.alloc(2);
    groups.writeUInt16BE(P.NAMED_GROUP.secp256r1, 0);
    exts.push(this._ext(P.EXTENSION.SUPPORTED_GROUPS, P.vec16(groups)));

    // ec_point_formats: uncompressed
    exts.push(this._ext(P.EXTENSION.EC_POINT_FORMATS, P.vec8(Buffer.from([P.EC_POINT_FORMAT.uncompressed]))));

    // signature_algorithms: ecdsa_secp256r1_sha256
    const sigalgs = Buffer.from([P.HASH_ALG.sha256, P.SIG_ALG.ecdsa]);
    exts.push(this._ext(P.EXTENSION.SIGNATURE_ALGORITHMS, P.vec16(sigalgs)));

    // extended_master_secret (empty)
    exts.push(this._ext(P.EXTENSION.EXTENDED_MASTER_SECRET, Buffer.alloc(0)));

    return Buffer.concat(exts);
  }

  _ext(type: number, body: Buffer): Buffer {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(body.length, 2);
    return Buffer.concat([head, body]);
  }

  _clientHandle(type: number, body: Buffer): void {
    switch (type) {
      case P.HANDSHAKE_TYPE.HELLO_VERIFY_REQUEST: {
        // Extract cookie and resend ClientHello. Not added to transcript.
        // body: server_version(2) || cookie<0..255>
        const cookieLen = body.readUInt8(2);
        this._cookie = body.slice(3, 3 + cookieLen);
        this._clearRetransmit();
        // Reset message seq: RFC 6347 — second ClientHello has message_seq 1.
        this._sendClientHello();
        break;
      }
      case P.HANDSHAKE_TYPE.SERVER_HELLO:
        this._appendInboundTranscript(type, body);
        this._parseServerHello(body);
        break;
      case P.HANDSHAKE_TYPE.CERTIFICATE:
        this._appendInboundTranscript(type, body);
        this._remoteCertDer = this._parseCertificate(body);
        break;
      case P.HANDSHAKE_TYPE.SERVER_KEY_EXCHANGE:
        this._appendInboundTranscript(type, body);
        this._parseServerKeyExchange(body);
        break;
      case P.HANDSHAKE_TYPE.CERTIFICATE_REQUEST:
        // We always send our certificate (WebRTC is mutual-auth), so the
        // request only needs to be folded into the transcript.
        this._appendInboundTranscript(type, body);
        break;
      case P.HANDSHAKE_TYPE.SERVER_HELLO_DONE:
        this._appendInboundTranscript(type, body);
        this._clearRetransmit();
        this._sendClientSecondFlight();
        break;
      case P.HANDSHAKE_TYPE.FINISHED:
        this._verifyPeerFinished(body, P.FINISHED_LABEL.SERVER);
        this._appendInboundTranscript(type, body);
        this._onHandshakeComplete();
        break;
      default:
        break;
    }
  }

  _parseServerHello(body: Buffer): void {
    // server_version(2) || random(32) || session_id<vec8> || cipher_suite(2)
    // || compression(1) || extensions<vec16>
    let o = 2;
    this._serverRandom = body.slice(o, o + 32);
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
          this._useExtendedMasterSecret = true;
        }
        o += elen;
      }
    }
  }

  _sendClientSecondFlight(): void {
    // Generate our ECDHE key.
    this._ecdh = crypto.createECDH('prime256v1');
    this._ecdh.generateKeys();
    const clientPub = this._ecdh.getPublicKey(); // uncompressed point (65 bytes)

    // Compute pre-master secret = ECDH(serverPub).
    const pms = this._ecdh.computeSecret(this._remoteEcdhePub!);

    // client Certificate
    const certMsg = this._buildCertificateMessage();
    // ClientKeyExchange: ECPoint as vec8
    const cke = P.vec8(clientPub);

    // Build the messages we're about to send so the transcript is correct for
    // CertificateVerify (which signs everything through ClientKeyExchange) and
    // for the master secret (EMS hashes through ClientKeyExchange).
    const certSeq = this._handshakeMessageSeq;
    const ckeSeq = certSeq + 1;
    const certFull = P.encodeHandshake(P.HANDSHAKE_TYPE.CERTIFICATE, certSeq, certMsg);
    const ckeFull = P.encodeHandshake(P.HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE, ckeSeq, cke);

    // Master secret derivation.
    if (this._useExtendedMasterSecret) {
      const h = crypto.createHash('sha256');
      for (const m of this._transcript) h.update(m);
      h.update(certFull);
      h.update(ckeFull);
      const sessionHash = h.digest();
      this._masterSecret = cipher.deriveExtendedMasterSecret(pms, sessionHash);
    } else {
      this._masterSecret = cipher.deriveMasterSecret(pms, this._clientRandom!, this._serverRandom!);
    }
    this._deriveCipherKeys();

    // CertificateVerify: sign the raw handshake transcript through
    // ClientKeyExchange. crypto.sign applies SHA-256 itself, so we feed it the
    // concatenated messages, not a pre-computed digest.
    const cvData = Buffer.concat([...this._transcript, certFull, ckeFull]);
    const cvSig = crypto.sign('sha256', cvData, { key: this._privateKey, dsaEncoding: 'der' });
    const cvBody = Buffer.concat([
      Buffer.from([P.HASH_ALG.sha256, P.SIG_ALG.ecdsa]),
      P.vec16(cvSig),
    ]);

    // Now actually send: Certificate, ClientKeyExchange, CertificateVerify
    // as a flight (these get recorded in transcript by _sendFlight), then CCS,
    // then Finished.
    this._sendFlight([
      { type: P.HANDSHAKE_TYPE.CERTIFICATE, body: certMsg },
      { type: P.HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE, body: cke },
      { type: P.HANDSHAKE_TYPE.CERTIFICATE_VERIFY, body: cvBody },
    ]);

    this._sendChangeCipherSpec();
    this._sendFinished(P.FINISHED_LABEL.CLIENT);
  }

  // ---- SERVER role --------------------------------------------------------

  _serverHandle(type: number, body: Buffer): void {
    switch (type) {
      case P.HANDSHAKE_TYPE.CLIENT_HELLO:
        this._handleClientHello(body);
        break;
      case P.HANDSHAKE_TYPE.CERTIFICATE:
        this._appendInboundTranscript(type, body);
        this._remoteCertDer = this._parseCertificate(body);
        break;
      case P.HANDSHAKE_TYPE.CLIENT_KEY_EXCHANGE: {
        this._appendInboundTranscript(type, body);
        const pubLen = body.readUInt8(0);
        this._remoteEcdhePub = body.slice(1, 1 + pubLen);
        const pms = this._ecdh!.computeSecret(this._remoteEcdhePub);
        if (this._useExtendedMasterSecret) {
          this._masterSecret = cipher.deriveExtendedMasterSecret(pms, this._transcriptHash());
        } else {
          this._masterSecret = cipher.deriveMasterSecret(pms, this._clientRandom!, this._serverRandom!);
        }
        this._deriveCipherKeys();
        break;
      }
      case P.HANDSHAKE_TYPE.CERTIFICATE_VERIFY:
        this._verifyClientCertificateVerify(body);
        this._appendInboundTranscript(type, body);
        break;
      case P.HANDSHAKE_TYPE.FINISHED:
        this._verifyPeerFinished(body, P.FINISHED_LABEL.CLIENT);
        this._appendInboundTranscript(type, body);
        // Server responds with its own CCS + Finished.
        this._sendChangeCipherSpec();
        this._sendFinished(P.FINISHED_LABEL.SERVER);
        this._onHandshakeComplete();
        break;
      default:
        break;
    }
  }

  _handleClientHello(body: Buffer): void {
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
    this._renegRequested = renegRequested;

    if (cookie.length === 0) {
      // Stateless cookie exchange: reply with HelloVerifyRequest. Not part of
      // the transcript, and we do not yet commit any state.
      this._clientRandom = random;
      this._sendHelloVerifyRequest(this._makeCookie(random));
      // The client resends ClientHello as message_seq 1; expect that next.
      this._reassembly.clear();
      this._nextExpectedHsSeq = 1;
      return;
    }

    // Validate cookie.
    const expected = this._makeCookie(random);
    if (!cookie.equals(expected)) {
      // Tolerate by just re-issuing HVR.
      this._sendHelloVerifyRequest(expected);
      this._reassembly.clear();
      this._nextExpectedHsSeq = 1;
      return;
    }

    // Cookie OK — this ClientHello starts the transcript.
    this._clientRandom = random;
    this._useExtendedMasterSecret = emsRequested;
    this._appendInboundTranscript(P.HANDSHAKE_TYPE.CLIENT_HELLO, body);
    this._sendServerFlight();
  }

  _makeCookie(clientRandom: Buffer): Buffer {
    if (!this._cookieSecret) this._cookieSecret = crypto.randomBytes(32);
    return crypto.createHmac('sha256', this._cookieSecret).update(clientRandom).digest().slice(0, 20);
  }

  _sendHelloVerifyRequest(cookie: Buffer): void {
    // body: server_version(2) || cookie<vec8>
    const body = Buffer.concat([Buffer.from([0xfe, 0xff]), P.vec8(cookie)]);
    // HVR uses message_seq 0 and is not retransmitted via flight machinery.
    const fragment = P.encodeHandshake(P.HANDSHAKE_TYPE.HELLO_VERIFY_REQUEST, 0, body);
    this._sendRecord(P.CONTENT_TYPE.HANDSHAKE, fragment);
    // Server-side handshake message seq for the real flight starts at 1.
    this._handshakeMessageSeq = 1;
  }

  _sendServerFlight(): void {
    this._serverRandom = this._makeRandom();
    this._ecdh = crypto.createECDH('prime256v1');
    this._ecdh.generateKeys();
    const serverPub = this._ecdh.getPublicKey();

    // ServerHello
    const shBody = this._buildServerHello();

    // Certificate
    const certMsg = this._buildCertificateMessage();

    // ServerKeyExchange: ServerECDHParams + signature
    const ecdhParams = Buffer.concat([
      Buffer.from([0x03]), // curve_type = named_curve
      (() => { const b = Buffer.alloc(2); b.writeUInt16BE(P.NAMED_GROUP.secp256r1, 0); return b; })(),
      P.vec8(serverPub),
    ]);
    const signed = Buffer.concat([this._clientRandom!, this._serverRandom, ecdhParams]);
    const sig = crypto.sign('sha256', signed, { key: this._privateKey, dsaEncoding: 'der' });
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

    this._sendFlight([
      { type: P.HANDSHAKE_TYPE.SERVER_HELLO, body: shBody },
      { type: P.HANDSHAKE_TYPE.CERTIFICATE, body: certMsg },
      { type: P.HANDSHAKE_TYPE.SERVER_KEY_EXCHANGE, body: skeBody },
      { type: P.HANDSHAKE_TYPE.CERTIFICATE_REQUEST, body: crBody },
      { type: P.HANDSHAKE_TYPE.SERVER_HELLO_DONE, body: shdBody },
    ]);
  }

  _buildServerHello(): Buffer {
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0xfe, 0xfd])); // server_version DTLS 1.2
    parts.push(this._serverRandom!);
    parts.push(P.vec8(Buffer.alloc(0))); // session_id empty
    const cs = Buffer.alloc(2);
    cs.writeUInt16BE(P.CIPHER_SUITE, 0);
    parts.push(cs); // cipher_suite (2 bytes, not a vector)
    parts.push(Buffer.from([0x00])); // compression null
    // extensions
    const exts: Buffer[] = [];
    if (this._useExtendedMasterSecret) {
      exts.push(this._ext(P.EXTENSION.EXTENDED_MASTER_SECRET, Buffer.alloc(0)));
    }
    exts.push(this._ext(P.EXTENSION.EC_POINT_FORMATS, P.vec8(Buffer.from([P.EC_POINT_FORMAT.uncompressed]))));
    // Acknowledge secure renegotiation with an empty renegotiated_connection
    // (a 1-byte zero-length vector). Required by OpenSSL 3.x clients.
    if (this._renegRequested) {
      exts.push(this._ext(P.EXTENSION.RENEGOTIATION_INFO, P.vec8(Buffer.alloc(0))));
    }
    parts.push(P.vec16(Buffer.concat(exts)));
    return Buffer.concat(parts);
  }

  _verifyClientCertificateVerify(body: Buffer): void {
    // body: SignatureAndHashAlgorithm(2) || signature<vec16>
    const sigLen = body.readUInt16BE(2);
    const sig = body.slice(4, 4 + sigLen);
    // Verify over the raw transcript through ClientKeyExchange (crypto.verify
    // hashes internally, mirroring the signer).
    const data = this._transcriptBytes();
    const pub = this._publicKeyFromCert(this._remoteCertDer!);
    const ok = crypto.verify('sha256', data, { key: pub, dsaEncoding: 'der' }, sig);
    if (!ok) throw new Error('Client CertificateVerify signature invalid');
  }

  // ---- Shared handshake helpers ------------------------------------------

  /** Build a Certificate message carrying our single DER cert. */
  _buildCertificateMessage(): Buffer {
    // certificate_list: each entry is cert<vec24>; whole list is vec24.
    const entry = P.vec24(this._certDer);
    return P.vec24(entry);
  }

  /** Parse a Certificate message and return the first cert's DER. */
  _parseCertificate(body: Buffer): Buffer | null {
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
    if (this._verifyFingerprint) {
      const fp = { algorithm: 'sha-256', value: x509.fingerprint(certDer, 'sha-256') };
      if (!this._verifyFingerprint(fp, certDer)) {
        throw new Error('Remote certificate fingerprint mismatch');
      }
    }
    return certDer;
  }

  _parseServerKeyExchange(body: Buffer): void {
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
    this._remoteEcdhePub = serverPub;

    // Verify the signature over client_random || server_random || ECDHParams.
    const ecdhParams = body.slice(0, o);
    // skip SignatureAndHashAlgorithm(2)
    o += 2;
    const sigLen = body.readUInt16BE(o); o += 2;
    const sig = body.slice(o, o + sigLen);
    const signed = Buffer.concat([this._clientRandom!, this._serverRandom!, ecdhParams]);
    const pub = this._publicKeyFromCert(this._remoteCertDer!);
    const ok = crypto.verify('sha256', signed, { key: pub, dsaEncoding: 'der' }, sig);
    if (!ok) throw new Error('ServerKeyExchange signature invalid');
  }

  _publicKeyFromCert(certDer: Buffer): crypto.KeyObject {
    const cert = new crypto.X509Certificate(certDer);
    return cert.publicKey;
  }

  _deriveCipherKeys(): void {
    const { clientKey, serverKey, clientIV, serverIV } = cipher.deriveKeys(
      this._masterSecret!,
      this._clientRandom!,
      this._serverRandom!
    );
    if (this.role === ROLE.CLIENT) {
      this._writeCipher = new cipher.GcmCipher(clientKey, clientIV);
      this._readCipher = new cipher.GcmCipher(serverKey, serverIV);
    } else {
      this._writeCipher = new cipher.GcmCipher(serverKey, serverIV);
      this._readCipher = new cipher.GcmCipher(clientKey, clientIV);
    }
  }

  _sendFinished(label: string): void {
    const verifyData = prf(this._masterSecret!, label, this._transcriptHash(), 12);
    // Finished is itself a handshake message and goes into the transcript.
    const seq = this._handshakeMessageSeq++;
    const full = P.encodeHandshake(P.HANDSHAKE_TYPE.FINISHED, seq, verifyData);
    this._transcript.push(full);
    this._sendRecord(P.CONTENT_TYPE.HANDSHAKE, full);
  }

  _verifyPeerFinished(body: Buffer, label: string): void {
    const expected = prf(this._masterSecret!, label, this._transcriptHash(), 12);
    if (!crypto.timingSafeEqual(body, expected)) {
      throw new Error('Peer Finished verify_data mismatch');
    }
  }

  _onHandshakeComplete(): void {
    if (this._handshakeDone) return;
    this._handshakeDone = true;
    this._clearRetransmit();
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
    this._sendRecord(P.CONTENT_TYPE.APPLICATION_DATA, data);
  }

  /** Send a close_notify and tear down. */
  close(): void {
    if (this.state === STATE.CLOSED || this.state === STATE.FAILED) return;
    try {
      if (this._sendEncrypted) {
        this._sendRecord(
          P.CONTENT_TYPE.ALERT,
          Buffer.from([P.ALERT_LEVEL.WARNING, P.ALERT_DESC.CLOSE_NOTIFY])
        );
      }
    } catch (_) {
      // best-effort
    }
    this._clearRetransmit();
    this.state = STATE.CLOSED;
    this.emit('close');
  }

  _fail(err: Error): void {
    if (this.state === STATE.FAILED || this.state === STATE.CLOSED) return;
    this._clearRetransmit();
    this.state = STATE.FAILED;
    this.emit('error', err);
  }

  /** The peer's certificate DER, available after the handshake. */
  getRemoteCertificate(): Buffer | null {
    return this._remoteCertDer;
  }
}

export { DtlsConnection, ROLE, STATE };
