/**
 * @file transport-stack.js
 * @description Composes ICE -> DTLS -> SCTP -> DCEP into one transport, the
 * real WebRTC data-channel pipeline.
 * @module transport-stack
 *
 * Wiring:
 *   IceAgent  emits 'data' (non-STUN datagrams) -> DtlsConnection.handlePacket
 *   DtlsConnection.output                        -> IceAgent.send
 *   DtlsConnection 'data' (app records)          -> SctpAssociation.receivePacket
 *   SctpAssociation 'output'                     -> DtlsConnection.send
 *   SctpAssociation + DataChannelManager         -> RTCDataChannel
 *
 * The DTLS client/server role follows the negotiated a=setup; the SCTP client
 * (INIT initiator) is the DTLS client, per RFC 8832.
 */

'use strict';

const EventEmitter = require('events');
const { IceAgent } = require('./ice/ice-agent');
const { DtlsConnection, ROLE: DTLS_ROLE } = require('./dtls/connection');
const { SctpAssociation } = require('./sctp/association');
const { DataChannelManager } = require('./sctp/datachannel-manager');

class TransportStack extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {'controlling'|'controlled'} opts.iceRole
   * @param {'client'|'server'} opts.dtlsRole - from a=setup (active=client)
   * @param {string} opts.localUfrag
   * @param {string} opts.localPwd
   * @param {Buffer} opts.certDer
   * @param {crypto.KeyObject} opts.privateKey
   * @param {(fp:{algorithm:string,value:string})=>boolean} opts.verifyFingerprint
   */
  constructor(opts) {
    super();
    this._opts = opts;
    this.ice = new IceAgent({
      role: opts.iceRole,
      localUfrag: opts.localUfrag,
      localPwd: opts.localPwd,
    });
    this.dtls = null;
    this.sctp = null;
    this.dcm = null;
    this._dtlsStarted = false;

    this.ice.on('candidate', (c) => this.emit('candidate', c));
    this.ice.on('error', (e) => this.emit('error', e));
    this.ice.on('failed', () => this.emit('error', new Error('ICE failed')));

    // Inbound DTLS datagrams from the selected/learned path.
    this.ice.on('data', (msg) => {
      if (this.dtls) this.dtls.handlePacket(msg);
    });

    this.ice.on('connected', () => {
      this.emit('iceconnected');
      this._startDtls();
    });
  }

  /** Begin gathering local candidates. */
  async gather() {
    await this.ice.gather();
  }

  getLocalCandidates() {
    return this.ice.getLocalCandidates();
  }

  /** Provide the peer's ICE credentials and start checks when ready. */
  setRemote(ufrag, pwd) {
    this.ice.setRemoteCredentials(ufrag, pwd);
    this.ice.start();
  }

  addRemoteCandidate(cand) {
    this.ice.addRemoteCandidate(cand);
  }

  _startDtls() {
    if (this._dtlsStarted) return;
    this._dtlsStarted = true;

    this.dtls = new DtlsConnection({
      role: this._opts.dtlsRole === 'client' ? DTLS_ROLE.CLIENT : DTLS_ROLE.SERVER,
      certDer: this._opts.certDer,
      privateKey: this._opts.privateKey,
      verifyFingerprint: this._opts.verifyFingerprint,
      output: (datagram) => {
        try { this.ice.send(datagram); } catch (e) { this.emit('error', e); }
      },
    });

    this.dtls.on('connect', () => {
      this.emit('dtlsconnected');
      this._startSctp();
    });
    this.dtls.on('data', (record) => {
      if (this.sctp) this.sctp.receivePacket(record);
    });
    this.dtls.on('error', (e) => this.emit('error', e));
    this.dtls.on('close', () => this.emit('close'));

    this.dtls.start();
  }

  _startSctp() {
    const isClient = this._opts.dtlsRole === 'client';
    this.sctp = new SctpAssociation({ isClient });
    this.sctp.on('output', (pkt) => {
      try { this.dtls.send(pkt); } catch (e) { this.emit('error', e); }
    });
    this.sctp.on('error', (e) => this.emit('error', e));
    this.sctp.on('close', () => this.emit('close'));

    this.dcm = new DataChannelManager(this.sctp, isClient);
    this.dcm.on('open-request', (info) => this.emit('datachannel-request', info));

    this.sctp.on('established', () => {
      this.emit('sctpconnected');
      this.emit('ready');
    });

    this.sctp.start();
  }

  /** Open a locally-initiated data channel once SCTP is established. */
  openChannel(channel, init) {
    if (!this.dcm) throw new Error('SCTP not ready');
    this.dcm.openChannel(channel, init);
  }

  /** Accept an inbound channel created from a 'datachannel-request'. */
  acceptChannel(channel, info) {
    this.dcm.acceptChannel(channel, info);
  }

  isReady() {
    return this.sctp && this.sctp.state === 'established';
  }

  close() {
    if (this.sctp) try { this.sctp.shutdown(); } catch (_) {}
    if (this.dtls) try { this.dtls.close(); } catch (_) {}
    if (this.ice) try { this.ice.close(); } catch (_) {}
  }
}

module.exports = { TransportStack };
