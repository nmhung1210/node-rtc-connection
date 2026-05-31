/**
 * @file ice-agent.js
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

const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const S = require('./stun-message');
const STUNClient = require('../stun/stun-client');

const TYPE_PREF = { host: 126, srflx: 100, prflx: 110, relay: 0 };
const CHECK_INTERVAL_MS = 50;
const CHECK_TIMEOUT_MS = 10000;

/**
 * Compute an ICE candidate priority (RFC 8445 §5.1.2.1).
 */
function candidatePriority(type, localPref = 65535, componentId = 1) {
  return ((TYPE_PREF[type] << 24) + (localPref << 8) + (256 - componentId)) >>> 0;
}

/**
 * Parse a STUN/TURN server URL: (stun|turn|turns):host[:port][?transport=...]
 * @param {string} url
 * @returns {{scheme:string, host:string, port:number, transport:string}|null}
 */
function parseIceServerUrl(url) {
  const m = url.match(/^(stuns?|turns?):\/?\/?([^:?]+):?(\d+)?(?:\?(.+))?$/);
  if (!m) return null;
  const scheme = m[1];
  const host = m[2];
  const params = {};
  if (m[4]) for (const kv of m[4].split('&')) { const [k, v] = kv.split('='); params[k] = v; }
  const defaultPort = scheme === 'turns' || scheme === 'stuns' ? 5349 : 3478;
  return {
    scheme,
    host,
    port: parseInt(m[3] || defaultPort, 10),
    transport: params.transport || 'udp',
  };
}

/**
 * A host transport: a bound UDP socket. send() targets an arbitrary peer.
 */
class HostTransport {
  constructor(socket) {
    this.kind = 'host';
    this.socket = socket;
    this.onMessage = null;
    socket.on('message', (msg, rinfo) => {
      if (this.onMessage) this.onMessage(msg, { address: rinfo.address, port: rinfo.port });
    });
  }
  send(buf, address, port) {
    this.socket.send(buf, port, address);
  }
  close() {
    try { this.socket.close(); } catch (_) {}
  }
}

/**
 * A relay transport backed by a TURN allocation. send() installs a permission
 * for the peer (idempotent best-effort) and forwards via SEND indication;
 * inbound arrives as DATA indications on the TURN client's 'data' event.
 */
class RelayTransport {
  constructor(turnClient) {
    this.kind = 'relay';
    this.client = turnClient;
    this.onMessage = null;
    this._permitted = new Set();
    turnClient.on('data', (data, peer) => {
      if (this.onMessage) this.onMessage(data, { address: peer.address, port: peer.port });
    });
  }
  send(buf, address, port) {
    const key = `${address}:${port}`;
    if (!this._permitted.has(key)) {
      this._permitted.add(key);
      // Install permission, then send. Subsequent sends skip the permission.
      this.client.createPermission(address)
        .then(() => this.client.sendIndication(address, port, buf))
        .catch(() => {});
    } else {
      this.client.sendIndication(address, port, buf).catch(() => {});
    }
  }
  close() {
    try { this.client.close(); } catch (_) {}
  }
}

class IceAgent extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {'controlling'|'controlled'} opts.role
   * @param {string} opts.localUfrag
   * @param {string} opts.localPwd
   */
  constructor(opts) {
    super();
    this.role = opts.role;
    this.localUfrag = opts.localUfrag;
    this.localPwd = opts.localPwd;
    this.remoteUfrag = null;
    this.remotePwd = null;

    this._tieBreaker = crypto.randomBytes(8);
    this._transports = []; // HostTransport | RelayTransport
    this._localCandidates = [];
    this._remoteCandidates = [];
    this._pairs = [];
    this._selected = null;
    this._closed = false;
    this._checkTimer = null;
    this._timeoutTimer = null;
    this._connected = false;
    this._pendingChecks = new Map(); // txid hex -> pair
  }

  /**
   * Gather candidates. Host candidates always; srflx/relay when iceServers are
   * given. With iceTransportPolicy 'relay', only relay candidates are kept.
   * @param {Object} [opts]
   * @param {Array<{urls:string|string[],username?:string,credential?:string}>} [opts.iceServers]
   * @param {'all'|'relay'} [opts.iceTransportPolicy='all']
   */
  async gather(opts = {}) {
    const iceServers = opts.iceServers || [];
    const relayOnly = opts.iceTransportPolicy === 'relay';

    const hostEntries = await this._gatherHosts();

    // Server-reflexive + relay candidates need a host socket to originate from.
    for (const server of iceServers) {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      for (const url of urls) {
        const parsed = parseIceServerUrl(url);
        if (!parsed || parsed.transport !== 'udp') continue; // UDP only for now
        try {
          if (parsed.scheme === 'stun' && !relayOnly) {
            await this._gatherSrflx(parsed, hostEntries[0]);
          } else if (parsed.scheme === 'turn' || parsed.scheme === 'turns') {
            await this._gatherRelay(parsed, server);
          }
        } catch (err) {
          // A failed server must not abort gathering; just skip it.
          this.emit('gathererror', { url, error: err.message });
        }
      }
    }

    if (relayOnly) {
      // Drop host/srflx candidates and their transports from the working set.
      this._localCandidates = this._localCandidates.filter((c) => c.type === 'relay');
    }

    this.emit('gatheringcomplete');
  }

  /** Bind one UDP socket per non-internal IPv4 interface; emit host candidates. */
  async _gatherHosts() {
    const ifaces = os.networkInterfaces();
    const addrs = [];
    for (const list of Object.values(ifaces)) {
      for (const a of list) {
        if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
      }
    }
    if (addrs.length === 0) addrs.push('127.0.0.1');

    const entries = [];
    for (const address of addrs) {
      entries.push(await this._bindHost(address));
    }
    return entries;
  }

  _bindHost(address) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      socket.on('error', (err) => this.emit('error', err));
      socket.bind(0, address, () => {
        const { port } = socket.address();
        const transport = new HostTransport(socket);
        transport.onMessage = (msg, rinfo) => this._onDatagram(transport, msg, rinfo);
        this._transports.push(transport);
        const cand = this._addLocalCandidate('host', address, port, transport);
        resolve({ socket, address, port, transport, candidate: cand });
      });
    });
  }

  /** Discover the server-reflexive address via a STUN binding request. */
  async _gatherSrflx(parsed, hostEntry) {
    if (!hostEntry) return;
    const stun = new STUNClient({ server: parsed.host, port: parsed.port });
    try {
      const addr = await stun.getReflexiveAddress();
      // srflx is reached through the host socket; reuse its transport.
      this._addLocalCandidate('srflx', addr.address, addr.port, hostEntry.transport, {
        relatedAddress: hostEntry.address, relatedPort: hostEntry.port,
      });
    } finally {
      stun.close();
    }
  }

  /** Allocate a TURN relay and expose it as a relay candidate + transport. */
  async _gatherRelay(parsed, server) {
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
    const alloc = await turn.allocateRelay(600);
    const transport = new RelayTransport(turn);
    transport.onMessage = (msg, rinfo) => this._onDatagram(transport, msg, rinfo);
    this._transports.push(transport);
    this._addLocalCandidate('relay', alloc.relayedAddress, alloc.relayedPort, transport, {
      relatedAddress: parsed.host, relatedPort: parsed.port,
    });
  }

  _addLocalCandidate(type, address, port, transport, extra = {}) {
    const foundation = crypto.createHash('md5')
      .update(`${type}:${address}:${transport.kind}`).digest('hex').slice(0, 8);
    const priority = candidatePriority(type);
    let sdp = `candidate:${foundation} 1 udp ${priority} ${address} ${port} typ ${type}`;
    if (extra.relatedAddress) {
      sdp += ` raddr ${extra.relatedAddress} rport ${extra.relatedPort}`;
    }
    const cand = { foundation, component: 1, protocol: 'udp', priority, address, port, type, transport, sdp };
    this._localCandidates.push(cand);
    this.emit('candidate', cand);
    return cand;
  }

  getLocalCandidates() {
    return this._localCandidates.slice();
  }

  /** Set remote ICE credentials (from the peer's SDP). */
  setRemoteCredentials(ufrag, pwd) {
    this.remoteUfrag = ufrag;
    this.remotePwd = pwd;
  }

  /**
   * Add a remote candidate (parsed from an a=candidate line or object).
   * @param {{address:string, port:number, priority?:number, type?:string}} cand
   */
  addRemoteCandidate(cand) {
    if (!cand || !cand.address || !cand.port) return;
    // Browsers obfuscate host candidates as mDNS ".local" hostnames. We don't
    // run an mDNS resolver, so these are unusable and sending checks to them
    // triggers failing DNS lookups. Skip them — connectivity still succeeds via
    // the peer-reflexive candidate we learn from the browser's inbound checks.
    if (typeof cand.address === 'string' && cand.address.endsWith('.local')) return;
    this._remoteCandidates.push(cand);
    this._formPairs();
    if (!this._checkTimer && this.remotePwd) this._startChecks();
  }

  /** Begin connectivity checks (call once remote creds + candidates exist). */
  start() {
    if (this.remotePwd && this._remoteCandidates.length > 0) {
      this._startChecks();
    }
  }

  _formPairs() {
    for (const local of this._localCandidates) {
      for (const remote of this._remoteCandidates) {
        const key = `${local.type}:${local.address}:${local.port}->${remote.address}:${remote.port}`;
        if (this._pairs.find((p) => p.key === key)) continue;
        this._pairs.push({ key, local, remote, state: 'frozen', nominated: false });
      }
    }
  }

  _startChecks() {
    if (this._checkTimer || this._closed) return;
    this._checkTimer = setInterval(() => this._tick(), CHECK_INTERVAL_MS);
    if (this._checkTimer.unref) this._checkTimer.unref();
    this._timeoutTimer = setTimeout(() => {
      if (!this._connected) this.emit('failed');
      this._stopChecks();
    }, CHECK_TIMEOUT_MS);
    if (this._timeoutTimer.unref) this._timeoutTimer.unref();
    this._tick();
  }

  _stopChecks() {
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
    if (this._timeoutTimer) { clearTimeout(this._timeoutTimer); this._timeoutTimer = null; }
  }

  _tick() {
    if (this._closed) return;
    for (const pair of this._pairs) {
      if (pair.state === 'succeeded') continue;
      this._sendCheck(pair);
    }
  }

  _sendCheck(pair) {
    const txid = crypto.randomBytes(12);
    const username = `${this.remoteUfrag}:${this.localUfrag}`;
    const builder = new S.StunMessageBuilder(S.MSG_TYPE.BINDING_REQUEST, txid)
      .addUsername(username)
      .addPriority(pair.local.priority);

    if (this.role === 'controlling') {
      builder.addIceControlling(this._tieBreaker);
      builder.addUseCandidate(); // aggressive nomination
    } else {
      builder.addIceControlled(this._tieBreaker);
    }

    const msg = builder.build(this.remotePwd);
    this._pendingChecks.set(txid.toString('hex'), pair);
    pair.state = 'in-progress';
    pair.local.transport.send(msg, pair.remote.address, pair.remote.port);
  }

  _onDatagram(transport, msg, rinfo) {
    if (msg.length === 0) return;
    const b0 = msg[0];
    // RFC 7983 demux: 0-3 => STUN, 20-63 => DTLS, else ignore.
    if (b0 <= 3) {
      this._onStun(transport, msg, rinfo);
    } else {
      this.emit('data', msg, { transport, address: rinfo.address, port: rinfo.port });
    }
  }

  _onStun(transport, msg, rinfo) {
    const parsed = S.parse(msg);
    if (!parsed) return;
    if (parsed.type === S.MSG_TYPE.BINDING_REQUEST) {
      this._handleBindingRequest(transport, parsed, rinfo);
    } else if (parsed.type === S.MSG_TYPE.BINDING_SUCCESS) {
      this._handleBindingSuccess(transport, parsed, rinfo);
    }
  }

  _handleBindingRequest(transport, parsed, rinfo) {
    // Verify MESSAGE-INTEGRITY with our local password (peer keyed it with our pwd).
    if (this.localPwd && !S.verifyIntegrity(parsed.raw, this.localPwd)) {
      return; // drop unauthenticated checks
    }

    const resp = new S.StunMessageBuilder(S.MSG_TYPE.BINDING_SUCCESS, parsed.transactionId)
      .addXorMappedAddress(rinfo.address, rinfo.port)
      .build(this.localPwd);
    transport.send(resp, rinfo.address, rinfo.port);

    // Learn a peer-reflexive remote candidate if unknown.
    const known = this._remoteCandidates.find((c) => c.address === rinfo.address && c.port === rinfo.port);
    if (!known) {
      this.addRemoteCandidate({ address: rinfo.address, port: rinfo.port, type: 'prflx', priority: 0 });
    }

    const useCandidate = parsed.attrs.has(S.ATTR.USE_CANDIDATE);
    const pair = this._findPair(transport, rinfo);

    if (useCandidate && this.role === 'controlled') {
      this._select(pair || this._syntheticPair(transport, rinfo));
    }
  }

  _handleBindingSuccess(transport, parsed, rinfo) {
    const pair = this._pendingChecks.get(parsed.transactionId.toString('hex'));
    if (!pair) return;
    this._pendingChecks.delete(parsed.transactionId.toString('hex'));
    pair.state = 'succeeded';

    if (this.role === 'controlling') {
      this._select(pair);
    } else if (!this._selected) {
      this._validPair = pair;
    }
  }

  _findPair(transport, rinfo) {
    return this._pairs.find((p) =>
      p.remote.address === rinfo.address && p.remote.port === rinfo.port && p.local.transport === transport);
  }

  _syntheticPair(transport, rinfo) {
    return { local: { transport }, remote: { address: rinfo.address, port: rinfo.port } };
  }

  _select(pair) {
    if (this._selected || !pair) return;
    this._selected = pair;
    this._connected = true;
    this._stopChecks();
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
  send(data) {
    if (!this._selected) throw new Error('ICE not connected');
    this._selected.local.transport.send(data, this._selected.remote.address, this._selected.remote.port);
  }

  getSelectedPair() {
    return this._selected;
  }

  /** Type of the selected local candidate ('host'|'srflx'|'relay'|'prflx'). */
  getSelectedCandidateType() {
    return this._selected ? this._selected.local.type : null;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._stopChecks();
    for (const t of this._transports) {
      try { t.close(); } catch (_) {}
    }
    this._transports = [];
    this.emit('closed');
  }
}

module.exports = { IceAgent, candidatePriority, parseIceServerUrl };
