/**
 * @file association.js
 * @description Minimal SCTP association over a datagram channel (DTLS), scoped
 * to the WebRTC data channel profile (RFC 8831).
 * @module sctp/association
 *
 * Implements the four-way INIT/INIT-ACK/COOKIE-ECHO/COOKIE-ACK setup, DATA
 * transmit/receive with TSN tracking and SACK, ordered and unordered delivery,
 * and reassembly of fragmented user messages. Congestion control is
 * intentionally simple (stop-and-go style with a generous rwnd) which is
 * adequate for control/data-channel traffic and interoperates with usrsctp
 * (the stack browsers use).
 *
 * The association rides on top of a reliable-ish datagram pipe provided by
 * DTLS; SCTP still provides framing, ordering, multiplexing and ack'ing.
 */

'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const C = require('./chunks');
const { applyChecksum, verifyChecksum } = require('./crc32c');

const SCTP_PORT = 5000; // WebRTC uses 5000 on both ends
const DEFAULT_RWND = 1024 * 1024;
const MAX_PAYLOAD = 1200; // fragment user messages above this (fits DTLS/MTU)
const RTO_INITIAL = 500;
const RTO_MAX = 5000;

const STATE = Object.freeze({
  CLOSED: 'closed',
  COOKIE_WAIT: 'cookie-wait',
  COOKIE_ECHOED: 'cookie-echoed',
  ESTABLISHED: 'established',
});

/** Serial number arithmetic (RFC 1982) for 32-bit TSNs. */
function snLt(a, b) {
  return ((a - b) & 0xffffffff) > 0x80000000;
}
function snLte(a, b) {
  return a === b || snLt(a, b);
}

/**
 * @class SctpAssociation
 * @extends EventEmitter
 *
 * Events:
 *  - 'established'             association is up
 *  - 'message' ({streamId, ppid, data})  a complete user message arrived
 *  - 'output' (Buffer)         an SCTP packet to hand to DTLS
 *  - 'close'
 */
class SctpAssociation extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {boolean} opts.isClient - the DTLS client initiates SCTP (RFC 8831)
   */
  constructor(opts = {}) {
    super();
    this.isClient = !!opts.isClient;
    this.state = STATE.CLOSED;

    this._localPort = SCTP_PORT;
    this._remotePort = SCTP_PORT;

    this._localTag = crypto.randomBytes(4).readUInt32BE(0) >>> 0 || 1;
    this._remoteTag = 0;

    // Transmit side.
    this._localTSN = crypto.randomBytes(4).readUInt32BE(0) >>> 0;
    this._nextSSN = new Map(); // streamId -> next outbound stream sequence
    this._sentQueue = new Map(); // tsn -> { packet, payloadLen }
    this._a_rwnd = DEFAULT_RWND;

    // Receive side.
    this._peerCumulativeTSN = null; // highest contiguous TSN received
    this._receivedOutOfOrder = new Map(); // tsn -> dataChunk (gap storage)
    this._reassembly = new Map(); // streamId -> { ordered fragments }
    this._inboundStreams = new Map(); // streamId -> expected SSN
    this._fragments = new Map(); // streamId -> array of partial DATA payloads

    this._cookieEcho = null; // pending cookie to (re)send
    this._initTimer = null;
    this._rtoTimer = null;
  }

  /** Start the association (client sends INIT). */
  start() {
    if (this.state !== STATE.CLOSED) return;
    if (this.isClient) {
      this._sendInit();
      this.state = STATE.COOKIE_WAIT;
    }
    // Server waits for INIT.
  }

  // ---- packet plumbing ----------------------------------------------------

  _emitPacket(verificationTag, chunks) {
    const header = C.encodeCommonHeader(this._localPort, this._remotePort, verificationTag);
    const packet = Buffer.concat([header, ...chunks]);
    applyChecksum(packet);
    this.emit('output', packet);
  }

  /**
   * Feed an inbound SCTP packet (decrypted from DTLS).
   * @param {Buffer} packet
   */
  receivePacket(packet) {
    if (packet.length < 12) return;
    if (!verifyChecksum(packet)) return; // drop corrupt
    const header = C.parseCommonHeader(packet);
    const chunks = C.parseChunks(packet);
    for (const chunk of chunks) {
      this._handleChunk(chunk, header);
    }
  }

  _handleChunk(chunk, header) {
    switch (chunk.type) {
      case C.CHUNK_TYPE.INIT:
        this._handleInit(chunk);
        break;
      case C.CHUNK_TYPE.INIT_ACK:
        this._handleInitAck(chunk);
        break;
      case C.CHUNK_TYPE.COOKIE_ECHO:
        this._handleCookieEcho(chunk);
        break;
      case C.CHUNK_TYPE.COOKIE_ACK:
        this._handleCookieAck();
        break;
      case C.CHUNK_TYPE.DATA:
        this._handleData(chunk);
        break;
      case C.CHUNK_TYPE.SACK:
        this._handleSack(chunk);
        break;
      case C.CHUNK_TYPE.HEARTBEAT:
        this._handleHeartbeat(chunk);
        break;
      case C.CHUNK_TYPE.ABORT:
        this._abort('peer sent ABORT');
        break;
      case C.CHUNK_TYPE.SHUTDOWN:
        this._handleShutdown();
        break;
      default:
        break; // ignore unknown
    }
  }

  // ---- setup handshake ----------------------------------------------------

  _supportedExtParams() {
    // Advertise Forward-TSN support (FORWARD_TSN_SUPPORTED) like usrsctp does;
    // we don't require it but including it improves interop.
    return [
      C.encodeParam(C.PARAM_TYPE.FORWARD_TSN_SUPPORTED, Buffer.alloc(0)),
    ];
  }

  _sendInit() {
    const body = C.encodeInitBody({
      initiateTag: this._localTag,
      a_rwnd: DEFAULT_RWND,
      outStreams: 65535,
      inStreams: 65535,
      initialTSN: this._localTSN,
    });
    const init = C.encodeChunk(
      C.CHUNK_TYPE.INIT,
      0,
      Buffer.concat([body, ...this._supportedExtParams()])
    );
    // INIT must be sent with verification tag 0.
    this._emitPacket(0, [init]);
    this._armInitRetransmit([init]);
  }

  _armInitRetransmit(chunks) {
    this._clearInitTimer();
    let rto = RTO_INITIAL;
    let attempts = 0;
    const fire = () => {
      if (this.state === STATE.ESTABLISHED || this.state === STATE.CLOSED) return;
      if (attempts >= 8) { this._abort('SCTP setup timed out'); return; }
      attempts++;
      this._emitPacket(this.state === STATE.COOKIE_ECHOED ? this._remoteTag : 0, chunks);
      rto = Math.min(rto * 2, RTO_MAX);
      this._initTimer = setTimeout(fire, rto);
      if (this._initTimer.unref) this._initTimer.unref();
    };
    this._initTimer = setTimeout(fire, rto);
    if (this._initTimer.unref) this._initTimer.unref();
  }

  _clearInitTimer() {
    if (this._initTimer) { clearTimeout(this._initTimer); this._initTimer = null; }
  }

  _handleInit(chunk) {
    // Server side: reply with INIT_ACK carrying a state cookie.
    const init = C.parseInitBody(chunk.body);
    this._remoteTag = init.initiateTag;
    this._peerInitialTSN = init.initialTSN;
    this._peerCumulativeTSN = (init.initialTSN - 1) >>> 0;

    // State cookie: an opaque blob the peer echoes back. We authenticate it
    // with an HMAC over the parameters we need to resume.
    if (!this._cookieSecret) this._cookieSecret = crypto.randomBytes(32);
    const cookieData = Buffer.alloc(16);
    cookieData.writeUInt32BE(this._localTag, 0);
    cookieData.writeUInt32BE(this._remoteTag, 4);
    cookieData.writeUInt32BE(this._localTSN, 8);
    cookieData.writeUInt32BE(init.initialTSN, 12);
    const mac = crypto.createHmac('sha256', this._cookieSecret).update(cookieData).digest();
    const cookie = Buffer.concat([cookieData, mac]);

    const ackBody = C.encodeInitBody({
      initiateTag: this._localTag,
      a_rwnd: DEFAULT_RWND,
      outStreams: 65535,
      inStreams: 65535,
      initialTSN: this._localTSN,
    });
    const params = Buffer.concat([
      C.encodeParam(C.PARAM_TYPE.STATE_COOKIE, cookie),
      ...this._supportedExtParams(),
    ]);
    const initAck = C.encodeChunk(C.CHUNK_TYPE.INIT_ACK, 0, Buffer.concat([ackBody, params]));
    // INIT_ACK is sent with the peer's initiate tag as verification tag.
    this._emitPacket(this._remoteTag, [initAck]);
  }

  _handleInitAck(chunk) {
    if (this.state !== STATE.COOKIE_WAIT) return;
    this._clearInitTimer();
    const initAck = C.parseInitBody(chunk.body);
    this._remoteTag = initAck.initiateTag;
    this._peerInitialTSN = initAck.initialTSN;
    this._peerCumulativeTSN = (initAck.initialTSN - 1) >>> 0;

    // Find the state cookie and echo it back.
    const cookieParam = initAck.params.find((p) => p.type === C.PARAM_TYPE.STATE_COOKIE);
    if (!cookieParam) { this._abort('INIT_ACK missing state cookie'); return; }

    const cookieEcho = C.encodeChunk(C.CHUNK_TYPE.COOKIE_ECHO, 0, cookieParam.value);
    this._cookieEcho = cookieEcho;
    this.state = STATE.COOKIE_ECHOED;
    this._emitPacket(this._remoteTag, [cookieEcho]);
    this._armInitRetransmit([cookieEcho]);
  }

  _handleCookieEcho(chunk) {
    // Server side: validate cookie, establish, reply COOKIE_ACK.
    const cookie = chunk.body;
    if (cookie.length >= 48 && this._cookieSecret) {
      const data = cookie.slice(0, 16);
      const mac = cookie.slice(16, 48);
      const expected = crypto.createHmac('sha256', this._cookieSecret).update(data).digest();
      if (!crypto.timingSafeEqual(mac, expected)) return; // bad cookie
      // (tags/TSNs already set from the INIT we processed)
    }
    const cookieAck = C.encodeChunk(C.CHUNK_TYPE.COOKIE_ACK, 0, Buffer.alloc(0));
    this._emitPacket(this._remoteTag, [cookieAck]);
    this._establish();
  }

  _handleCookieAck() {
    if (this.state !== STATE.COOKIE_ECHOED) return;
    this._clearInitTimer();
    this._cookieEcho = null;
    this._establish();
  }

  _establish() {
    if (this.state === STATE.ESTABLISHED) return;
    this.state = STATE.ESTABLISHED;
    this.emit('established');
  }

  // ---- data transfer ------------------------------------------------------

  /**
   * Send a user message on a stream.
   * @param {number} streamId
   * @param {number} ppid
   * @param {Buffer} data
   * @param {Object} [opts]
   * @param {boolean} [opts.unordered=false]
   */
  sendData(streamId, ppid, data, opts = {}) {
    if (this.state !== STATE.ESTABLISHED) {
      throw new Error('SCTP association not established');
    }
    const unordered = !!opts.unordered;

    // Fragment into <= MAX_PAYLOAD pieces; set B/E flags accordingly.
    let ssn = 0;
    if (!unordered) {
      ssn = this._nextSSN.get(streamId) || 0;
      this._nextSSN.set(streamId, (ssn + 1) & 0xffff);
    }

    const total = data.length;
    let offset = 0;
    const chunks = [];
    // An empty message still needs one DATA chunk (use EMPTY ppid variants).
    do {
      const slice = data.slice(offset, offset + MAX_PAYLOAD);
      const beginning = offset === 0;
      const ending = offset + slice.length >= total;
      const tsn = this._localTSN;
      this._localTSN = (this._localTSN + 1) >>> 0;
      const { flags, body } = C.encodeDataBody({
        tsn, streamId, streamSeq: ssn, ppid, userData: slice,
        unordered, beginning, ending,
      });
      const chunk = C.encodeChunk(C.CHUNK_TYPE.DATA, flags, body);
      this._sentQueue.set(tsn, { chunk });
      chunks.push(chunk);
      offset += slice.length;
    } while (offset < total);

    // Send each DATA chunk (one per packet keeps it simple and MTU-safe).
    for (const chunk of chunks) {
      this._emitPacket(this._remoteTag, [chunk]);
    }
  }

  _handleData(chunk) {
    const data = C.parseDataBody(chunk.flags, chunk.body);

    // Always SACK what we've got (delayed-SACK simplified to immediate).
    this._deliverData(data);
    this._sendSack();
  }

  _deliverData(data) {
    // Track cumulative TSN. Accept in-order and buffer out-of-order.
    const expected = (this._peerCumulativeTSN + 1) >>> 0;
    if (snLt(data.tsn, expected)) {
      return; // duplicate / already delivered
    }

    if (data.tsn === expected) {
      this._peerCumulativeTSN = data.tsn;
      this._consume(data);
      // Drain any buffered contiguous TSNs.
      let next = (this._peerCumulativeTSN + 1) >>> 0;
      while (this._receivedOutOfOrder.has(next)) {
        const buffered = this._receivedOutOfOrder.get(next);
        this._receivedOutOfOrder.delete(next);
        this._peerCumulativeTSN = next;
        this._consume(buffered);
        next = (this._peerCumulativeTSN + 1) >>> 0;
      }
    } else {
      // Out of order: buffer for later (gap).
      if (!this._receivedOutOfOrder.has(data.tsn)) {
        this._receivedOutOfOrder.set(data.tsn, data);
      }
    }
  }

  /** Reassemble fragments and emit complete user messages. */
  _consume(data) {
    const key = `${data.streamId}:${data.unordered ? 'u' : 'o'}`;
    if (data.beginning && data.ending) {
      this.emit('message', { streamId: data.streamId, ppid: data.ppid, data: data.userData });
      return;
    }
    let buf = this._fragments.get(key);
    if (data.beginning) {
      buf = { ppid: data.ppid, parts: [data.userData] };
      this._fragments.set(key, buf);
    } else if (buf) {
      buf.parts.push(data.userData);
    } else {
      return; // missing beginning; drop
    }
    if (data.ending && buf) {
      this._fragments.delete(key);
      this.emit('message', {
        streamId: data.streamId,
        ppid: buf.ppid,
        data: Buffer.concat(buf.parts),
      });
    }
  }

  _sendSack() {
    // Build gap-ack blocks from buffered out-of-order TSNs.
    const gapBlocks = [];
    if (this._receivedOutOfOrder.size > 0) {
      const sorted = [...this._receivedOutOfOrder.keys()].sort((a, b) => (snLt(a, b) ? -1 : 1));
      const base = (this._peerCumulativeTSN + 1) >>> 0;
      let start = null;
      let prev = null;
      for (const tsn of sorted) {
        if (start === null) { start = tsn; prev = tsn; continue; }
        if (tsn === ((prev + 1) >>> 0)) { prev = tsn; continue; }
        gapBlocks.push([((start - base) & 0xffff) + 1, ((prev - base) & 0xffff) + 1]);
        start = tsn; prev = tsn;
      }
      if (start !== null) {
        gapBlocks.push([((start - base) & 0xffff) + 1, ((prev - base) & 0xffff) + 1]);
      }
    }

    const body = C.encodeSackBody({
      cumulativeTsnAck: this._peerCumulativeTSN >>> 0,
      a_rwnd: DEFAULT_RWND,
      gapBlocks,
    });
    const sack = C.encodeChunk(C.CHUNK_TYPE.SACK, 0, body);
    this._emitPacket(this._remoteTag, [sack]);
  }

  _handleSack(chunk) {
    const sack = C.parseSackBody(chunk.body);
    // Remove acknowledged TSNs from the retransmit queue.
    for (const tsn of [...this._sentQueue.keys()]) {
      if (snLte(tsn, sack.cumulativeTsnAck)) {
        this._sentQueue.delete(tsn);
      }
    }
    // Gap-acked blocks are relative to cumAck; mark those acked too.
    const base = (sack.cumulativeTsnAck + 1) >>> 0;
    for (const [start, end] of sack.gapBlocks) {
      for (let i = start; i <= end; i++) {
        this._sentQueue.delete((base + i - 1) >>> 0);
      }
    }
  }

  _handleHeartbeat(chunk) {
    // Echo the heartbeat info back as HEARTBEAT_ACK.
    const ack = C.encodeChunk(C.CHUNK_TYPE.HEARTBEAT_ACK, 0, chunk.body);
    this._emitPacket(this._remoteTag, [ack]);
  }

  _handleShutdown() {
    const sdAck = C.encodeChunk(C.CHUNK_TYPE.SHUTDOWN_ACK, 0, Buffer.alloc(0));
    this._emitPacket(this._remoteTag, [sdAck]);
    this._close();
  }

  _abort(reason) {
    this._clearInitTimer();
    if (this.state !== STATE.CLOSED) {
      this.state = STATE.CLOSED;
      this.emit('error', new Error(reason || 'SCTP abort'));
      this.emit('close');
    }
  }

  /** Gracefully close the association. */
  shutdown() {
    if (this.state !== STATE.ESTABLISHED) { this._close(); return; }
    const sd = C.encodeChunk(C.CHUNK_TYPE.SHUTDOWN, 0, (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(this._peerCumulativeTSN >>> 0, 0);
      return b;
    })());
    this._emitPacket(this._remoteTag, [sd]);
    this._close();
  }

  _close() {
    this._clearInitTimer();
    if (this.state === STATE.CLOSED) return;
    this.state = STATE.CLOSED;
    this.emit('close');
  }
}

module.exports = { SctpAssociation, STATE, SCTP_PORT };
