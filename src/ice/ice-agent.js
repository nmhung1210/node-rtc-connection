/**
 * @file ice-agent.js
 * @description A small but RFC 8445-compliant ICE agent for a single data
 * component, with browser-compatible connectivity checks.
 * @module ice/ice-agent
 *
 * Responsibilities:
 *  - Gather UDP host candidates (and, optionally, server-reflexive via the
 *    existing STUN client).
 *  - Send/answer STUN Binding connectivity checks carrying USERNAME,
 *    MESSAGE-INTEGRITY (keyed by the remote/local ice-pwd), PRIORITY, the
 *    ICE-CONTROLLING/CONTROLLED role attribute, and USE-CANDIDATE.
 *  - Nominate a candidate pair and expose it as the selected path.
 *  - Demultiplex inbound datagrams per RFC 7983: STUN (first byte 0-3) is
 *    handled internally; everything else (DTLS records, first byte 20-63) is
 *    emitted as 'data' for the upper stack.
 *
 * This is deliberately a "full" ICE-lite-ish agent: it both initiates checks
 * and responds to the peer's checks, which is what is needed to connect to a
 * browser doing full ICE.
 */

'use strict';

const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const EventEmitter = require('events');
const S = require('./stun-message');

const TYPE_PREF = { host: 126, srflx: 100, relay: 0 };
const CHECK_INTERVAL_MS = 50;
const CHECK_TIMEOUT_MS = 10000;

/**
 * Compute an ICE candidate priority (RFC 8445 §5.1.2.1).
 */
function candidatePriority(type, localPref = 65535, componentId = 1) {
  return ((TYPE_PREF[type] << 24) + (localPref << 8) + (256 - componentId)) >>> 0;
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
    this._sockets = []; // { socket, address, port }
    this._localCandidates = [];
    this._remoteCandidates = [];
    this._pairs = [];
    this._selected = null;
    this._closed = false;
    this._checkTimer = null;
    this._timeoutTimer = null;
    this._connected = false;
    // Transaction map for checks we initiated: txid hex -> pair
    this._pendingChecks = new Map();
  }

  /** Gather UDP host candidates on all non-internal IPv4 interfaces. */
  async gather() {
    const ifaces = os.networkInterfaces();
    const addrs = [];
    for (const list of Object.values(ifaces)) {
      for (const a of list) {
        if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
      }
    }
    if (addrs.length === 0) addrs.push('127.0.0.1');

    for (const address of addrs) {
      await this._bindSocket(address);
    }
    this.emit('gatheringcomplete');
  }

  _bindSocket(address) {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      socket.on('error', (err) => this.emit('error', err));
      socket.on('message', (msg, rinfo) => this._onDatagram(socket, msg, rinfo));
      socket.bind(0, address, () => {
        const { port } = socket.address();
        const entry = { socket, address, port };
        this._sockets.push(entry);
        const foundation = crypto.createHash('md5').update(address).digest('hex').slice(0, 8);
        const priority = candidatePriority('host');
        const cand = {
          foundation,
          component: 1,
          protocol: 'udp',
          priority,
          address,
          port,
          type: 'host',
          socketEntry: entry,
          sdp: `candidate:${foundation} 1 udp ${priority} ${address} ${port} typ host`,
        };
        this._localCandidates.push(cand);
        this.emit('candidate', cand);
        resolve();
      });
    });
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
   * @param {{address:string, port:number, priority?:number, type?:string, foundation?:string}} cand
   */
  addRemoteCandidate(cand) {
    if (!cand || !cand.address || !cand.port) return;
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
        const key = `${local.address}:${local.port}->${remote.address}:${remote.port}`;
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
    // Send a check on each not-yet-succeeded pair.
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
      .addPriority(candidatePriority('host'));

    if (this.role === 'controlling') {
      builder.addIceControlling(this._tieBreaker);
      // Aggressive nomination: mark the check we want to nominate.
      builder.addUseCandidate();
    } else {
      builder.addIceControlled(this._tieBreaker);
    }

    const msg = builder.build(this.remotePwd);
    this._pendingChecks.set(txid.toString('hex'), pair);
    pair.state = 'in-progress';
    pair.local.socketEntry.socket.send(msg, pair.remote.port, pair.remote.address);
  }

  _onDatagram(socket, msg, rinfo) {
    if (msg.length === 0) return;
    const b0 = msg[0];
    // RFC 7983 demux: 0-3 => STUN, 20-63 => DTLS, else (rare) ignore here.
    if (b0 <= 3) {
      this._onStun(socket, msg, rinfo);
    } else {
      // Hand non-STUN (DTLS) datagrams to the upper layer, tagged with the
      // path they arrived on so replies go back the same way.
      this.emit('data', msg, { socket, address: rinfo.address, port: rinfo.port });
    }
  }

  _onStun(socket, msg, rinfo) {
    const parsed = S.parse(msg);
    if (!parsed) return;

    if (parsed.type === S.MSG_TYPE.BINDING_REQUEST) {
      this._handleBindingRequest(socket, parsed, rinfo);
    } else if (parsed.type === S.MSG_TYPE.BINDING_SUCCESS) {
      this._handleBindingSuccess(parsed, rinfo);
    }
  }

  _handleBindingRequest(socket, parsed, rinfo) {
    // Verify MESSAGE-INTEGRITY with our local password (peer keyed it with our pwd).
    if (this.localPwd && !S.verifyIntegrity(parsed.raw, this.localPwd)) {
      return; // silently drop unauthenticated checks
    }

    // Respond with a success carrying XOR-MAPPED-ADDRESS, integrity (our pwd),
    // and fingerprint.
    const resp = new S.StunMessageBuilder(S.MSG_TYPE.BINDING_SUCCESS, parsed.transactionId)
      .addXorMappedAddress(rinfo.address, rinfo.port)
      .build(this.localPwd);
    socket.send(resp, rinfo.port, rinfo.address);

    // Learn a peer-reflexive remote candidate if unknown, so we can send checks
    // back to where this came from (important for symmetric NAT / browsers).
    const known = this._remoteCandidates.find((c) => c.address === rinfo.address && c.port === rinfo.port);
    if (!known) {
      this.addRemoteCandidate({ address: rinfo.address, port: rinfo.port, type: 'prflx', priority: 0 });
    }

    const useCandidate = parsed.attrs.has(S.ATTR.USE_CANDIDATE);
    const socketEntry = this._sockets.find((s) => s.socket === socket);
    const pair = this._pairs.find((p) =>
      p.remote.address === rinfo.address && p.remote.port === rinfo.port && p.local.socketEntry === socketEntry);

    // If the controlling peer nominated this pair, select it.
    if (useCandidate && this.role === 'controlled') {
      this._select(pair || { local: { socketEntry }, remote: { address: rinfo.address, port: rinfo.port } });
    }
  }

  _handleBindingSuccess(parsed, rinfo) {
    const pair = this._pendingChecks.get(parsed.transactionId.toString('hex'));
    if (!pair) return;
    this._pendingChecks.delete(parsed.transactionId.toString('hex'));
    pair.state = 'succeeded';

    // Controlling agent (aggressive nomination): first success is the path.
    if (this.role === 'controlling') {
      this._select(pair);
    } else if (!this._selected) {
      // Controlled: remember a valid pair; final selection waits for the
      // peer's USE-CANDIDATE, but we can use it if nothing else nominates.
      this._validPair = pair;
    }
  }

  _select(pair) {
    if (this._selected || !pair) return;
    this._selected = pair;
    this._connected = true;
    this._stopChecks();
    this.emit('selected', {
      socket: pair.local.socketEntry.socket,
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
    const { socketEntry } = this._selected.local;
    socketEntry.socket.send(data, this._selected.remote.port, this._selected.remote.address);
  }

  getSelectedPair() {
    return this._selected;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._stopChecks();
    for (const { socket } of this._sockets) {
      try { socket.close(); } catch (_) {}
    }
    this._sockets = [];
    this.emit('closed');
  }
}

module.exports = { IceAgent, candidatePriority };
