/**
 * @file association.ts
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

import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as C from './chunks';
import { applyChecksum, verifyChecksum } from './crc32c';

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

type StateValue = (typeof STATE)[keyof typeof STATE];

/** Options for constructing an {@link SctpAssociation}. */
export interface SctpAssociationOptions {
  /** the DTLS client initiates SCTP (RFC 8831) */
  isClient?: boolean;
}

/** A complete user message surfaced via the 'message' event. */
export interface SctpMessage {
  streamId: number;
  ppid: number;
  data: Buffer;
}

/** A queued DATA chunk awaiting SACK. */
interface SentEntry {
  chunk: Buffer;
}

/** In-progress reassembly buffer for a fragmented user message. */
interface FragmentBuffer {
  ppid: number;
  parts: Buffer[];
}

/** Serial number arithmetic (RFC 1982) for 32-bit TSNs. */
function snLt(a: number, b: number): boolean {
  return ((a - b) & 0xffffffff) > 0x80000000;
}
function snLte(a: number, b: number): boolean {
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
  isClient: boolean;
  state: StateValue;

  #localPort: number;
  #remotePort: number;

  #localTag: number;
  #remoteTag: number;

  // Transmit side.
  #localTSN: number;
  #nextSSN: Map<number, number>; // streamId -> next outbound stream sequence
  #sentQueue: Map<number, SentEntry>; // tsn -> { chunk } awaiting SACK

  // Receive side.
  #peerCumulativeTSN: number | null; // highest contiguous TSN received
  #receivedOutOfOrder: Map<number, C.ParsedDataBody>; // tsn -> dataChunk (gap storage)
  #fragments: Map<string, FragmentBuffer>; // streamId -> array of partial DATA payloads

  #initTimer: ReturnType<typeof setTimeout> | null;

  #cookieSecret?: Buffer;

  /**
   * @param {Object} opts
   * @param {boolean} opts.isClient - the DTLS client initiates SCTP (RFC 8831)
   */
  constructor(opts: SctpAssociationOptions = {}) {
    super();
    this.isClient = !!opts.isClient;
    this.state = STATE.CLOSED;

    this.#localPort = SCTP_PORT;
    this.#remotePort = SCTP_PORT;

    this.#localTag = crypto.randomBytes(4).readUInt32BE(0) >>> 0 || 1;
    this.#remoteTag = 0;

    // Transmit side.
    this.#localTSN = crypto.randomBytes(4).readUInt32BE(0) >>> 0;
    this.#nextSSN = new Map(); // streamId -> next outbound stream sequence
    this.#sentQueue = new Map(); // tsn -> { chunk } awaiting SACK

    // Receive side.
    this.#peerCumulativeTSN = null; // highest contiguous TSN received
    this.#receivedOutOfOrder = new Map(); // tsn -> dataChunk (gap storage)
    this.#fragments = new Map(); // streamId -> array of partial DATA payloads

    this.#initTimer = null;
  }

  /** Start the association (client sends INIT). */
  start(): void {
    if (this.state !== STATE.CLOSED) return;
    if (this.isClient) {
      this.#sendInit();
      this.state = STATE.COOKIE_WAIT;
    }
    // Server waits for INIT.
  }

  // ---- packet plumbing ----------------------------------------------------

  #emitPacket(verificationTag: number, chunks: Buffer[]): void {
    const header = C.encodeCommonHeader(this.#localPort, this.#remotePort, verificationTag);
    const packet = Buffer.concat([header, ...chunks]);
    applyChecksum(packet);
    this.emit('output', packet);
  }

  /**
   * Feed an inbound SCTP packet (decrypted from DTLS).
   * @param {Buffer} packet
   */
  receivePacket(packet: Buffer): void {
    if (packet.length < 12) return;
    if (!verifyChecksum(packet)) return; // drop corrupt
    const header = C.parseCommonHeader(packet);
    const chunks = C.parseChunks(packet);
    for (const chunk of chunks) {
      this.#handleChunk(chunk, header);
    }
  }

  #handleChunk(chunk: C.ParsedChunk, _header: C.CommonHeader): void {
    switch (chunk.type) {
      case C.CHUNK_TYPE.INIT:
        this.#handleInit(chunk);
        break;
      case C.CHUNK_TYPE.INIT_ACK:
        this.#handleInitAck(chunk);
        break;
      case C.CHUNK_TYPE.COOKIE_ECHO:
        this.#handleCookieEcho(chunk);
        break;
      case C.CHUNK_TYPE.COOKIE_ACK:
        this.#handleCookieAck();
        break;
      case C.CHUNK_TYPE.DATA:
        this.#handleData(chunk);
        break;
      case C.CHUNK_TYPE.SACK:
        this.#handleSack(chunk);
        break;
      case C.CHUNK_TYPE.HEARTBEAT:
        this.#handleHeartbeat(chunk);
        break;
      case C.CHUNK_TYPE.ABORT:
        this.#abort('peer sent ABORT');
        break;
      case C.CHUNK_TYPE.SHUTDOWN:
        this.#handleShutdown();
        break;
      default:
        break; // ignore unknown
    }
  }

  // ---- setup handshake ----------------------------------------------------

  #supportedExtParams(): Buffer[] {
    // Advertise Forward-TSN support (FORWARD_TSN_SUPPORTED) like usrsctp does;
    // we don't require it but including it improves interop.
    return [
      C.encodeParam(C.PARAM_TYPE.FORWARD_TSN_SUPPORTED, Buffer.alloc(0)),
    ];
  }

  #sendInit(): void {
    const body = C.encodeInitBody({
      initiateTag: this.#localTag,
      a_rwnd: DEFAULT_RWND,
      outStreams: 65535,
      inStreams: 65535,
      initialTSN: this.#localTSN,
    });
    const init = C.encodeChunk(
      C.CHUNK_TYPE.INIT,
      0,
      Buffer.concat([body, ...this.#supportedExtParams()])
    );
    // INIT must be sent with verification tag 0.
    this.#emitPacket(0, [init]);
    this.#armInitRetransmit([init]);
  }

  #armInitRetransmit(chunks: Buffer[]): void {
    this.#clearInitTimer();
    let rto = RTO_INITIAL;
    let attempts = 0;
    const fire = (): void => {
      if (this.state === STATE.ESTABLISHED || this.state === STATE.CLOSED) return;
      if (attempts >= 8) { this.#abort('SCTP setup timed out'); return; }
      attempts++;
      this.#emitPacket(this.state === STATE.COOKIE_ECHOED ? this.#remoteTag : 0, chunks);
      rto = Math.min(rto * 2, RTO_MAX);
      this.#initTimer = setTimeout(fire, rto);
      if (this.#initTimer.unref) this.#initTimer.unref();
    };
    this.#initTimer = setTimeout(fire, rto);
    if (this.#initTimer.unref) this.#initTimer.unref();
  }

  #clearInitTimer(): void {
    if (this.#initTimer) { clearTimeout(this.#initTimer); this.#initTimer = null; }
  }

  #handleInit(chunk: C.ParsedChunk): void {
    // Server side: reply with INIT_ACK carrying a state cookie.
    const init = C.parseInitBody(chunk.body);
    this.#remoteTag = init.initiateTag;
    this.#peerCumulativeTSN = (init.initialTSN - 1) >>> 0;

    // State cookie: an opaque blob the peer echoes back. We authenticate it
    // with an HMAC over the parameters we need to resume.
    if (!this.#cookieSecret) this.#cookieSecret = crypto.randomBytes(32);
    const cookieData = Buffer.alloc(16);
    cookieData.writeUInt32BE(this.#localTag, 0);
    cookieData.writeUInt32BE(this.#remoteTag, 4);
    cookieData.writeUInt32BE(this.#localTSN, 8);
    cookieData.writeUInt32BE(init.initialTSN, 12);
    const mac = crypto.createHmac('sha256', this.#cookieSecret).update(cookieData).digest();
    const cookie = Buffer.concat([cookieData, mac]);

    const ackBody = C.encodeInitBody({
      initiateTag: this.#localTag,
      a_rwnd: DEFAULT_RWND,
      outStreams: 65535,
      inStreams: 65535,
      initialTSN: this.#localTSN,
    });
    const params = Buffer.concat([
      C.encodeParam(C.PARAM_TYPE.STATE_COOKIE, cookie),
      ...this.#supportedExtParams(),
    ]);
    const initAck = C.encodeChunk(C.CHUNK_TYPE.INIT_ACK, 0, Buffer.concat([ackBody, params]));
    // INIT_ACK is sent with the peer's initiate tag as verification tag.
    this.#emitPacket(this.#remoteTag, [initAck]);
  }

  #handleInitAck(chunk: C.ParsedChunk): void {
    if (this.state !== STATE.COOKIE_WAIT) return;
    this.#clearInitTimer();
    const initAck = C.parseInitBody(chunk.body);
    this.#remoteTag = initAck.initiateTag;
    this.#peerCumulativeTSN = (initAck.initialTSN - 1) >>> 0;

    // Find the state cookie and echo it back.
    const cookieParam = initAck.params.find((p) => p.type === C.PARAM_TYPE.STATE_COOKIE);
    if (!cookieParam) { this.#abort('INIT_ACK missing state cookie'); return; }

    const cookieEcho = C.encodeChunk(C.CHUNK_TYPE.COOKIE_ECHO, 0, cookieParam.value);
    this.state = STATE.COOKIE_ECHOED;
    this.#emitPacket(this.#remoteTag, [cookieEcho]);
    this.#armInitRetransmit([cookieEcho]);
  }

  #handleCookieEcho(chunk: C.ParsedChunk): void {
    // Server side: validate cookie, establish, reply COOKIE_ACK.
    const cookie = chunk.body;
    if (cookie.length >= 48 && this.#cookieSecret) {
      const data = cookie.slice(0, 16);
      const mac = cookie.slice(16, 48);
      const expected = crypto.createHmac('sha256', this.#cookieSecret).update(data).digest();
      if (!crypto.timingSafeEqual(mac, expected)) return; // bad cookie
      // (tags/TSNs already set from the INIT we processed)
    }
    const cookieAck = C.encodeChunk(C.CHUNK_TYPE.COOKIE_ACK, 0, Buffer.alloc(0));
    this.#emitPacket(this.#remoteTag, [cookieAck]);
    this.#establish();
  }

  #handleCookieAck(): void {
    if (this.state !== STATE.COOKIE_ECHOED) return;
    this.#clearInitTimer();
    this.#establish();
  }

  #establish(): void {
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
  sendData(streamId: number, ppid: number, data: Buffer, opts: { unordered?: boolean } = {}): void {
    if (this.state !== STATE.ESTABLISHED) {
      throw new Error('SCTP association not established');
    }
    const unordered = !!opts.unordered;

    // Fragment into <= MAX_PAYLOAD pieces; set B/E flags accordingly.
    let ssn = 0;
    if (!unordered) {
      ssn = this.#nextSSN.get(streamId) || 0;
      this.#nextSSN.set(streamId, (ssn + 1) & 0xffff);
    }

    const total = data.length;
    let offset = 0;
    const chunks: Buffer[] = [];
    // An empty message still needs one DATA chunk (use EMPTY ppid variants).
    do {
      const slice = data.slice(offset, offset + MAX_PAYLOAD);
      const beginning = offset === 0;
      const ending = offset + slice.length >= total;
      const tsn = this.#localTSN;
      this.#localTSN = (this.#localTSN + 1) >>> 0;
      const { flags, body } = C.encodeDataBody({
        tsn, streamId, streamSeq: ssn, ppid, userData: slice,
        unordered, beginning, ending,
      });
      const chunk = C.encodeChunk(C.CHUNK_TYPE.DATA, flags, body);
      this.#sentQueue.set(tsn, { chunk });
      chunks.push(chunk);
      offset += slice.length;
    } while (offset < total);

    // Send each DATA chunk (one per packet keeps it simple and MTU-safe).
    for (const chunk of chunks) {
      this.#emitPacket(this.#remoteTag, [chunk]);
    }
  }

  #handleData(chunk: C.ParsedChunk): void {
    const data = C.parseDataBody(chunk.flags, chunk.body);

    // Always SACK what we've got (delayed-SACK simplified to immediate).
    this.#deliverData(data);
    this.#sendSack();
  }

  #deliverData(data: C.ParsedDataBody): void {
    // Track cumulative TSN. Accept in-order and buffer out-of-order.
    const expected = ((this.#peerCumulativeTSN as number) + 1) >>> 0;
    if (snLt(data.tsn, expected)) {
      return; // duplicate / already delivered
    }

    if (data.tsn === expected) {
      this.#peerCumulativeTSN = data.tsn;
      this.#consume(data);
      // Drain any buffered contiguous TSNs.
      let next = (this.#peerCumulativeTSN + 1) >>> 0;
      while (this.#receivedOutOfOrder.has(next)) {
        const buffered = this.#receivedOutOfOrder.get(next) as C.ParsedDataBody;
        this.#receivedOutOfOrder.delete(next);
        this.#peerCumulativeTSN = next;
        this.#consume(buffered);
        next = (this.#peerCumulativeTSN + 1) >>> 0;
      }
    } else {
      // Out of order: buffer for later (gap).
      if (!this.#receivedOutOfOrder.has(data.tsn)) {
        this.#receivedOutOfOrder.set(data.tsn, data);
      }
    }
  }

  /** Reassemble fragments and emit complete user messages. */
  #consume(data: C.ParsedDataBody): void {
    const key = `${data.streamId}:${data.unordered ? 'u' : 'o'}`;
    if (data.beginning && data.ending) {
      this.emit('message', { streamId: data.streamId, ppid: data.ppid, data: data.userData });
      return;
    }
    let buf = this.#fragments.get(key);
    if (data.beginning) {
      buf = { ppid: data.ppid, parts: [data.userData] };
      this.#fragments.set(key, buf);
    } else if (buf) {
      buf.parts.push(data.userData);
    } else {
      return; // missing beginning; drop
    }
    if (data.ending && buf) {
      this.#fragments.delete(key);
      this.emit('message', {
        streamId: data.streamId,
        ppid: buf.ppid,
        data: Buffer.concat(buf.parts),
      });
    }
  }

  #sendSack(): void {
    // Build gap-ack blocks from buffered out-of-order TSNs. Per RFC 4960
    // §3.3.4, each block's Start/End is the offset of the TSN from the
    // Cumulative TSN Ack — a 16-bit field. Offsets are computed with
    // serial-number wraparound; blocks whose offset exceeds 0xffff cannot be
    // represented and are skipped rather than overflowing the field.
    const gapBlocks: Array<[number, number]> = [];
    if (this.#receivedOutOfOrder.size > 0) {
      const cum = this.#peerCumulativeTSN as number;
      const offset = (tsn: number) => (tsn - cum) >>> 0; // distance ahead of cumAck
      const pushBlock = (start: number, end: number) => {
        const s = offset(start);
        const e = offset(end);
        if (e <= 0xffff) gapBlocks.push([s, e]);
      };
      const sorted = [...this.#receivedOutOfOrder.keys()].sort((a, b) => (snLt(a, b) ? -1 : 1));
      let start: number | null = null;
      let prev: number | null = null;
      for (const tsn of sorted) {
        if (start === null) { start = tsn; prev = tsn; continue; }
        if (tsn === (((prev as number) + 1) >>> 0)) { prev = tsn; continue; }
        pushBlock(start, prev as number);
        start = tsn; prev = tsn;
      }
      if (start !== null) pushBlock(start, prev as number);
    }

    const body = C.encodeSackBody({
      cumulativeTSNAck: (this.#peerCumulativeTSN as number) >>> 0,
      a_rwnd: DEFAULT_RWND,
      gapBlocks,
    });
    const sack = C.encodeChunk(C.CHUNK_TYPE.SACK, 0, body);
    this.#emitPacket(this.#remoteTag, [sack]);
  }

  #handleSack(chunk: C.ParsedChunk): void {
    const sack = C.parseSackBody(chunk.body);
    // Remove acknowledged TSNs from the retransmit queue.
    for (const tsn of [...this.#sentQueue.keys()]) {
      if (snLte(tsn, sack.cumulativeTSNAck)) {
        this.#sentQueue.delete(tsn);
      }
    }
    // Gap-acked blocks are relative to cumAck; mark those acked too.
    const base = (sack.cumulativeTSNAck + 1) >>> 0;
    for (const [start, end] of sack.gapBlocks) {
      for (let i = start; i <= end; i++) {
        this.#sentQueue.delete((base + i - 1) >>> 0);
      }
    }
  }

  #handleHeartbeat(chunk: C.ParsedChunk): void {
    // Echo the heartbeat info back as HEARTBEAT_ACK.
    const ack = C.encodeChunk(C.CHUNK_TYPE.HEARTBEAT_ACK, 0, chunk.body);
    this.#emitPacket(this.#remoteTag, [ack]);
  }

  #handleShutdown(): void {
    const sdAck = C.encodeChunk(C.CHUNK_TYPE.SHUTDOWN_ACK, 0, Buffer.alloc(0));
    this.#emitPacket(this.#remoteTag, [sdAck]);
    this.#close();
  }

  #abort(reason?: string): void {
    this.#clearInitTimer();
    if (this.state !== STATE.CLOSED) {
      this.state = STATE.CLOSED;
      this.emit('error', new Error(reason || 'SCTP abort'));
      this.emit('close');
    }
  }

  /** Gracefully close the association. */
  shutdown(): void {
    if (this.state !== STATE.ESTABLISHED) { this.#close(); return; }
    const sd = C.encodeChunk(C.CHUNK_TYPE.SHUTDOWN, 0, (() => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE((this.#peerCumulativeTSN as number) >>> 0, 0);
      return b;
    })());
    this.#emitPacket(this.#remoteTag, [sd]);
    this.#close();
  }

  #close(): void {
    this.#clearInitTimer();
    if (this.state === STATE.CLOSED) return;
    this.state = STATE.CLOSED;
    this.emit('close');
  }
}

export { SctpAssociation, STATE, SCTP_PORT };
