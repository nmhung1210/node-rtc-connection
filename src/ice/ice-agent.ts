/**
 * @file ice-agent.ts
 * @description A small but RFC 8445-compliant ICE agent for a single data
 * component, with browser-compatible connectivity checks and TURN relay.
 * @module ice/ice-agent
 *
 * Responsibilities:
 *  - Gather UDP host candidates, server-reflexive (srflx) candidates via STUN,
 *    and relay candidates via TURN (RFC 5766 ALLOCATE).
 *  - Send/answer STUN Binding connectivity checks carrying USERNAME,
 *    MESSAGE-INTEGRITY (keyed by the remote/local ice-pwd), PRIORITY, the
 *    ICE-CONTROLLING/CONTROLLED role attribute, and USE-CANDIDATE.
 *  - Nominate a candidate pair and expose it as the selected path.
 *  - Demultiplex inbound datagrams per RFC 7983: STUN (first byte 0-3) is
 *    handled internally; everything else (DTLS records, first byte 20-63) is
 *    emitted as 'data' for the upper stack.
 *
 * Each local candidate carries a `transport` with a uniform interface so the
 * connectivity-check and data paths are identical whether the candidate is a
 * host socket or a TURN relay:
 *   transport.send(buf, remoteAddress, remotePort)
 *   transport.onMessage = (buf, {address, port}) => ...
 */

'use strict';

import * as dgram from 'dgram';
import * as os from 'os';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import * as S from './stun-message';
import STUNClient from '../stun/stun-client';

const TYPE_PREF: Record<string, number> = { host: 126, srflx: 100, prflx: 110, relay: 0 };
const CHECK_INTERVAL_MS = 50;
const CHECK_TIMEOUT_MS = 10000;

/** Remote info accompanying an inbound datagram. */
interface RemoteInfo {
  address: string;
  port: number;
}

/**
 * Uniform transport abstraction shared by host sockets and TURN relays.
 */
interface Transport {
  kind: string;
  send(buf: Buffer, address: string, port: number): void;
  onMessage: ((msg: Buffer, rinfo: RemoteInfo) => void) | null;
  close(): void;
}

/** A local ICE candidate. */
interface LocalCandidate {
  foundation: string;
  component: number;
  protocol: string;
  priority: number;
  address: string;
  port: number;
  type: string;
  transport: Transport;
  sdp: string;
}

/** A remote ICE candidate (parsed from an a=candidate line or object). */
interface RemoteCandidate {
  address: string;
  port: number;
  priority?: number;
  type?: string;
}

/** A candidate pair under connectivity checking. */
interface CandidatePair {
  key?: string;
  local: { transport: Transport } & Partial<LocalCandidate>;
  remote: { address: string; port: number } & Partial<RemoteCandidate>;
  state?: string;
  nominated?: boolean;
}

/** Description of a single ICE server entry. */
interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Options accepted by {@link IceAgent#gather}. */
interface GatherOptions {
  iceServers?: IceServer[];
  iceTransportPolicy?: 'all' | 'relay';
}

/** Parsed query parameters from a STUN/TURN URL. */
type IceServerParams = Record<string, string | true>;

/** Result of {@link parseIceServerUrl}. */
interface ParsedIceServerUrl {
  scheme: string;
  protocol: string;
  host: string;
  port: number;
  transport: string;
  params: IceServerParams;
}

/** Options accepted by the {@link IceAgent} constructor. */
interface IceAgentOptions {
  role: 'controlling' | 'controlled';
  localUfrag: string;
  localPwd: string;
}

/** Bookkeeping for a bound host socket and its derived candidate. */
interface HostEntry {
  socket: dgram.Socket;
  address: string;
  port: number;
  transport: Transport;
  candidate: LocalCandidate;
}

/** Extra fields stored alongside a candidate (related address/port). */
interface CandidateExtra {
  relatedAddress?: string;
  relatedPort?: number;
}

/**
 * Compute an ICE candidate priority (RFC 8445 §5.1.2.1).
 */
function candidatePriority(type: string, localPref = 65535, componentId = 1): number {
  return ((TYPE_PREF[type]! << 24) + (localPref << 8) + (256 - componentId)) >>> 0;
}

/**
 * Parse a STUN/TURN server URL: (stun|turn|turns):host[:port][?key=val&...].
 * Query parameters are returned in `params`; a flag without a value (e.g.
 * "?secure") is recorded as `true`, an empty value ("?transport=") as "".
 * @param {string} url
 * @returns {{scheme:string, protocol:string, host:string, port:number,
 *            transport:string, params:Object}|null} null if the URL is invalid.
 */
function parseIceServerUrl(url: string): ParsedIceServerUrl | null {
  const m = url.match(/^(stuns?|turns?):\/?\/?([^:?]+):?(\d+)?(?:\?(.+))?$/);
  if (!m) return null;
  const scheme = m[1]!;
  const host = m[2]!;
  const params: IceServerParams = {};
  if (m[4]) {
    for (const kv of m[4].split('&')) {
      if (!kv) continue;
      const eq = kv.indexOf('=');
      if (eq === -1) params[kv] = true; // flag without a value
      else params[kv.slice(0, eq)] = kv.slice(eq + 1); // value may be ""
    }
  }
  const defaultPort = scheme === 'turns' || scheme === 'stuns' ? 5349 : 3478;
  return {
    scheme,
    protocol: scheme, // alias
    host,
    port: parseInt(m[3] || String(defaultPort), 10),
    transport: typeof params.transport === 'string' ? params.transport : 'udp',
    params,
  };
}

/**
 * A host transport: a bound UDP socket. send() targets an arbitrary peer.
 */
class HostTransport implements Transport {
  kind: string;
  #socket: dgram.Socket;
  onMessage: ((msg: Buffer, rinfo: RemoteInfo) => void) | null;

  constructor(socket: dgram.Socket) {
    this.kind = 'host';
    this.#socket = socket;
    this.onMessage = null;
    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      if (this.onMessage) this.onMessage(msg, { address: rinfo.address, port: rinfo.port });
    });
  }
  send(buf: Buffer, address: string, port: number): void {
    this.#socket.send(buf, port, address);
  }
  close(): void {
    try { this.#socket.close(); } catch (_) {}
  }
}

/**
 * A relay transport backed by a TURN allocation. send() installs a permission
 * for the peer (idempotent best-effort) and forwards via SEND indication;
 * inbound arrives as DATA indications on the TURN client's 'data' event.
 */
class RelayTransport implements Transport {
  kind: string;
  #client: STUNClient;
  onMessage: ((msg: Buffer, rinfo: RemoteInfo) => void) | null;
  #permitted: Set<string>;

  constructor(turnClient: STUNClient) {
    this.kind = 'relay';
    this.#client = turnClient;
    this.onMessage = null;
    this.#permitted = new Set();
    turnClient.on('data', (data: Buffer, peer: { address: string; port: number }) => {
      if (this.onMessage) this.onMessage(data, { address: peer.address, port: peer.port });
    });
  }
  send(buf: Buffer, address: string, port: number): void {
    const key = `${address}:${port}`;
    if (!this.#permitted.has(key)) {
      this.#permitted.add(key);
      // Install permission, then send. Subsequent sends skip the permission.
      this.#client.createPermission(address)
        .then(() => this.#client.sendIndication(address, port, buf))
        .catch(() => {});
    } else {
      this.#client.sendIndication(address, port, buf).catch(() => {});
    }
  }
  close(): void {
    try { this.#client.close(); } catch (_) {}
  }
}

class IceAgent extends EventEmitter {
  role: 'controlling' | 'controlled';
  localUfrag: string;
  localPwd: string;
  remoteUfrag: string | null;
  remotePwd: string | null;

  #tieBreaker: Buffer;
  #transports: Transport[];
  #localCandidates: LocalCandidate[];
  #remoteCandidates: RemoteCandidate[];
  #pairs: CandidatePair[];
  #selected: CandidatePair | null;
  #closed: boolean;
  #checkTimer: NodeJS.Timeout | null;
  #timeoutTimer: NodeJS.Timeout | null;
  #connected: boolean;
  #pendingChecks: Map<string, CandidatePair>;

  /**
   * @param {Object} opts
   * @param {'controlling'|'controlled'} opts.role
   * @param {string} opts.localUfrag
   * @param {string} opts.localPwd
   */
  constructor(opts: IceAgentOptions) {
    super();
    this.role = opts.role;
    this.localUfrag = opts.localUfrag;
    this.localPwd = opts.localPwd;
    this.remoteUfrag = null;
    this.remotePwd = null;

    this.#tieBreaker = crypto.randomBytes(8);
    this.#transports = []; // HostTransport | RelayTransport
    this.#localCandidates = [];
    this.#remoteCandidates = [];
    this.#pairs = [];
    this.#selected = null;
    this.#closed = false;
    this.#checkTimer = null;
    this.#timeoutTimer = null;
    this.#connected = false;
    this.#pendingChecks = new Map(); // txid hex -> pair
  }

  /**
   * Gather candidates. Host candidates always; srflx/relay when iceServers are
   * given. With iceTransportPolicy 'relay', only relay candidates are kept.
   * @param {Object} [opts]
   * @param {Array<{urls:string|string[],username?:string,credential?:string}>} [opts.iceServers]
   * @param {'all'|'relay'} [opts.iceTransportPolicy='all']
   */
  async gather(opts: GatherOptions = {}): Promise<void> {
    const iceServers = opts.iceServers || [];
    const relayOnly = opts.iceTransportPolicy === 'relay';

    const hostEntries = await this.#gatherHosts();

    // Server-reflexive + relay candidates need a host socket to originate from.
    for (const server of iceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const url of urls) {
        const parsed = parseIceServerUrl(url);
        if (!parsed || parsed.transport !== 'udp') continue; // UDP only for now
        try {
          if (parsed.scheme === 'stun' && !relayOnly) {
            await this.#gatherSrflx(parsed, hostEntries[0]);
          } else if (parsed.scheme === 'turn' || parsed.scheme === 'turns') {
            await this.#gatherRelay(parsed, server);
          }
        } catch (err) {
          // A failed server must not abort gathering; just skip it.
          this.emit('gathererror', { url, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (relayOnly) {
      // Drop host/srflx candidates and their transports from the working set.
      this.#localCandidates = this.#localCandidates.filter((c) => c.type === 'relay');
    }

    this.emit('gatheringcomplete');
  }

  /** Bind one UDP socket per non-internal IPv4 interface; emit host candidates. */
  async #gatherHosts(): Promise<HostEntry[]> {
    const ifaces = os.networkInterfaces();
    const addrs: string[] = [];
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const a of list) {
        if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
      }
    }
    if (addrs.length === 0) addrs.push('127.0.0.1');

    const entries: HostEntry[] = [];
    for (const address of addrs) {
      entries.push(await this.#bindHost(address));
    }
    return entries;
  }

  #bindHost(address: string): Promise<HostEntry> {
    return new Promise((resolve, _reject) => {
      const socket = dgram.createSocket('udp4');
      socket.on('error', (err: Error) => this.emit('error', err));
      socket.bind(0, address, () => {
        const { port } = socket.address();
        const transport = new HostTransport(socket);
        transport.onMessage = (msg, rinfo) => this.#onDatagram(transport, msg, rinfo);
        this.#transports.push(transport);
        const cand = this.#addLocalCandidate('host', address, port, transport);
        resolve({ socket, address, port, transport, candidate: cand });
      });
    });
  }

  /** Discover the server-reflexive address via a STUN binding request. */
  async #gatherSrflx(parsed: ParsedIceServerUrl, hostEntry: HostEntry | undefined): Promise<void> {
    if (!hostEntry) return;
    const stun = new STUNClient({ server: parsed.host, port: parsed.port });
    try {
      const addr = await stun.getReflexiveAddress() as { address: string; port: number };
      // srflx is reached through the host socket; reuse its transport.
      this.#addLocalCandidate('srflx', addr.address, addr.port, hostEntry.transport, {
        relatedAddress: hostEntry.address, relatedPort: hostEntry.port,
      });
    } finally {
      stun.close();
    }
  }

  /** Allocate a TURN relay and expose it as a relay candidate + transport. */
  async #gatherRelay(parsed: ParsedIceServerUrl, server: IceServer): Promise<void> {
    if (!server.username || !server.credential) {
      throw new Error('TURN server requires username and credential');
    }
    const turn = new STUNClient({
      server: parsed.host,
      port: parsed.port,
      username: server.username,
      credential: server.credential,
      transport: parsed.transport,
    });
    const alloc = await turn.allocateRelay(600) as { relayedAddress: string; relayedPort: number };
    const transport = new RelayTransport(turn);
    transport.onMessage = (msg, rinfo) => this.#onDatagram(transport, msg, rinfo);
    this.#transports.push(transport);
    this.#addLocalCandidate('relay', alloc.relayedAddress, alloc.relayedPort, transport, {
      relatedAddress: parsed.host, relatedPort: parsed.port,
    });
  }

  #addLocalCandidate(
    type: string,
    address: string,
    port: number,
    transport: Transport,
    extra: CandidateExtra = {}
  ): LocalCandidate {
    const foundation = crypto.createHash('md5')
      .update(`${type}:${address}:${transport.kind}`).digest('hex').slice(0, 8);
    const priority = candidatePriority(type);
    let sdp = `candidate:${foundation} 1 udp ${priority} ${address} ${port} typ ${type}`;
    if (extra.relatedAddress) {
      sdp += ` raddr ${extra.relatedAddress} rport ${extra.relatedPort}`;
    }
    const cand: LocalCandidate = { foundation, component: 1, protocol: 'udp', priority, address, port, type, transport, sdp };
    this.#localCandidates.push(cand);
    this.emit('candidate', cand);
    return cand;
  }

  getLocalCandidates(): LocalCandidate[] {
    return this.#localCandidates.slice();
  }

  /** Set remote ICE credentials (from the peer's SDP). */
  setRemoteCredentials(ufrag: string, pwd: string): void {
    this.remoteUfrag = ufrag;
    this.remotePwd = pwd;
  }

  /**
   * Add a remote candidate (parsed from an a=candidate line or object).
   * @param {{address:string, port:number, priority?:number, type?:string}} cand
   */
  addRemoteCandidate(cand: RemoteCandidate): void {
    if (!cand || !cand.address || !cand.port) return;
    // Browsers obfuscate host candidates as mDNS ".local" hostnames. We don't
    // run an mDNS resolver, so these are unusable and sending checks to them
    // triggers failing DNS lookups. Skip them — connectivity still succeeds via
    // the peer-reflexive candidate we learn from the browser's inbound checks.
    if (typeof cand.address === 'string' && cand.address.endsWith('.local')) return;
    this.#remoteCandidates.push(cand);
    this.#formPairs();
    if (!this.#checkTimer && this.remotePwd) this.#startChecks();
  }

  /** Begin connectivity checks (call once remote creds + candidates exist). */
  start(): void {
    if (this.remotePwd && this.#remoteCandidates.length > 0) {
      this.#startChecks();
    }
  }

  #formPairs(): void {
    for (const local of this.#localCandidates) {
      for (const remote of this.#remoteCandidates) {
        const key = `${local.type}:${local.address}:${local.port}->${remote.address}:${remote.port}`;
        if (this.#pairs.find((p) => p.key === key)) continue;
        this.#pairs.push({ key, local, remote, state: 'frozen', nominated: false });
      }
    }
  }

  #startChecks(): void {
    if (this.#checkTimer || this.#closed) return;
    this.#checkTimer = setInterval(() => this.#tick(), CHECK_INTERVAL_MS);
    if (this.#checkTimer.unref) this.#checkTimer.unref();
    this.#timeoutTimer = setTimeout(() => {
      if (!this.#connected) this.emit('failed');
      this.#stopChecks();
    }, CHECK_TIMEOUT_MS);
    if (this.#timeoutTimer.unref) this.#timeoutTimer.unref();
    this.#tick();
  }

  #stopChecks(): void {
    if (this.#checkTimer) { clearInterval(this.#checkTimer); this.#checkTimer = null; }
    if (this.#timeoutTimer) { clearTimeout(this.#timeoutTimer); this.#timeoutTimer = null; }
  }

  #tick(): void {
    if (this.#closed) return;
    for (const pair of this.#pairs) {
      if (pair.state === 'succeeded') continue;
      this.#sendCheck(pair);
    }
  }

  #sendCheck(pair: CandidatePair): void {
    const txid = crypto.randomBytes(12);
    const username = `${this.remoteUfrag}:${this.localUfrag}`;
    const builder = new S.StunMessageBuilder(S.MSG_TYPE.BINDING_REQUEST, txid)
      .addUsername(username)
      .addPriority(pair.local.priority!);

    if (this.role === 'controlling') {
      builder.addIceControlling(this.#tieBreaker);
      builder.addUseCandidate(); // aggressive nomination
    } else {
      builder.addIceControlled(this.#tieBreaker);
    }

    const msg = builder.build(this.remotePwd ?? undefined);
    this.#pendingChecks.set(txid.toString('hex'), pair);
    pair.state = 'in-progress';
    pair.local.transport.send(msg, pair.remote.address, pair.remote.port);
  }

  #onDatagram(transport: Transport, msg: Buffer, rinfo: RemoteInfo): void {
    if (msg.length === 0) return;
    const b0 = msg[0]!;
    // RFC 7983 demux: 0-3 => STUN, 20-63 => DTLS, else ignore.
    if (b0 <= 3) {
      this.#onStun(transport, msg, rinfo);
    } else {
      this.emit('data', msg, { transport, address: rinfo.address, port: rinfo.port });
    }
  }

  #onStun(transport: Transport, msg: Buffer, rinfo: RemoteInfo): void {
    const parsed = S.parse(msg);
    if (!parsed) return;
    if (parsed.type === S.MSG_TYPE.BINDING_REQUEST) {
      this.#handleBindingRequest(transport, parsed, rinfo);
    } else if (parsed.type === S.MSG_TYPE.BINDING_SUCCESS) {
      this.#handleBindingSuccess(transport, parsed, rinfo);
    }
  }

  #handleBindingRequest(transport: Transport, parsed: S.ParsedStunMessage, rinfo: RemoteInfo): void {
    // Verify MESSAGE-INTEGRITY with our local password (peer keyed it with our pwd).
    if (this.localPwd && !S.verifyIntegrity(parsed.raw, this.localPwd)) {
      return; // drop unauthenticated checks
    }

    const resp = new S.StunMessageBuilder(S.MSG_TYPE.BINDING_SUCCESS, parsed.transactionId)
      .addXorMappedAddress(rinfo.address, rinfo.port)
      .build(this.localPwd);
    transport.send(resp, rinfo.address, rinfo.port);

    // Learn a peer-reflexive remote candidate if unknown.
    const known = this.#remoteCandidates.find((c) => c.address === rinfo.address && c.port === rinfo.port);
    if (!known) {
      this.addRemoteCandidate({ address: rinfo.address, port: rinfo.port, type: 'prflx', priority: 0 });
    }

    const useCandidate = parsed.attrs.has(S.ATTR.USE_CANDIDATE);
    const pair = this.#findPair(transport, rinfo);

    if (useCandidate && this.role === 'controlled') {
      this.#select(pair || this.#syntheticPair(transport, rinfo));
    }
  }

  #handleBindingSuccess(_transport: Transport, parsed: S.ParsedStunMessage, _rinfo: RemoteInfo): void {
    const pair = this.#pendingChecks.get(parsed.transactionId.toString('hex'));
    if (!pair) return;
    this.#pendingChecks.delete(parsed.transactionId.toString('hex'));
    pair.state = 'succeeded';

    if (this.role === 'controlling') {
      this.#select(pair);
    }
    // Controlled agent: a successful check confirms the pair is valid, but the
    // path is selected when the controlling peer sends USE-CANDIDATE.
  }

  #findPair(transport: Transport, rinfo: RemoteInfo): CandidatePair | undefined {
    return this.#pairs.find((p) =>
      p.remote.address === rinfo.address && p.remote.port === rinfo.port && p.local.transport === transport);
  }

  #syntheticPair(transport: Transport, rinfo: RemoteInfo): CandidatePair {
    return { local: { transport }, remote: { address: rinfo.address, port: rinfo.port } };
  }

  #select(pair: CandidatePair | undefined): void {
    if (this.#selected || !pair) return;
    this.#selected = pair;
    this.#connected = true;
    this.#stopChecks();
    this.emit('selected', {
      transport: pair.local.transport,
      candidateType: pair.local.type,
      remoteAddress: pair.remote.address,
      remotePort: pair.remote.port,
    });
    this.emit('connected');
  }

  /**
   * Send application (DTLS) data over the selected path.
   * @param {Buffer} data
   */
  send(data: Buffer): void {
    if (!this.#selected) throw new Error('ICE not connected');
    this.#selected.local.transport.send(data, this.#selected.remote.address, this.#selected.remote.port);
  }

  getSelectedPair(): CandidatePair | null {
    return this.#selected;
  }

  /** Type of the selected local candidate ('host'|'srflx'|'relay'|'prflx'). */
  getSelectedCandidateType(): string | null | undefined {
    return this.#selected ? this.#selected.local.type : null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopChecks();
    for (const t of this.#transports) {
      try { t.close(); } catch (_) {}
    }
    this.#transports = [];
    this.emit('closed');
  }
}

export { IceAgent, candidatePriority, parseIceServerUrl };
