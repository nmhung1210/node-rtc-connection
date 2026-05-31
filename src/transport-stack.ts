/**
 * @file transport-stack.ts
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

import { EventEmitter } from 'events';
import { IceAgent } from './ice/ice-agent';
import { DtlsConnection, ROLE as DTLS_ROLE } from './dtls/connection';
import { SctpAssociation } from './sctp/association';
import { DataChannelManager, OpenRequestInfo } from './sctp/datachannel-manager';
import type { RTCDataChannel, RTCDataChannelInit } from './datachannel/RTCDataChannel';
import type { KeyObject } from 'crypto';

export interface TransportStackOptions {
  /** ICE controlling vs controlled (offerer is controlling). */
  iceRole: 'controlling' | 'controlled';
  /** DTLS role from a=setup (active=client). */
  dtlsRole: 'client' | 'server';
  localUfrag: string;
  localPwd: string;
  certDer: Buffer;
  privateKey: KeyObject;
  verifyFingerprint?: (fp: { algorithm: string; value: string }) => boolean;
}

export class TransportStack extends EventEmitter {
  private _opts: TransportStackOptions;
  ice: IceAgent;
  dtls: DtlsConnection | null;
  sctp: SctpAssociation | null;
  dcm: DataChannelManager | null;
  private _dtlsStarted: boolean;

  constructor(opts: TransportStackOptions) {
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
    this.ice.on('data', (msg: Buffer) => {
      if (this.dtls) this.dtls.handlePacket(msg);
    });

    this.ice.on('connected', () => {
      this.emit('iceconnected');
      this._startDtls();
    });
  }

  /**
   * Begin gathering local candidates.
   * @param opts - { iceServers, iceTransportPolicy } forwarded to ICE.
   */
  async gather(opts: { iceServers?: unknown[]; iceTransportPolicy?: 'all' | 'relay' } = {}): Promise<void> {
    await this.ice.gather(opts as any);
  }

  getLocalCandidates(): ReturnType<IceAgent['getLocalCandidates']> {
    return this.ice.getLocalCandidates();
  }

  /** Provide the peer's ICE credentials and start checks when ready. */
  setRemote(ufrag: string, pwd: string): void {
    this.ice.setRemoteCredentials(ufrag, pwd);
    this.ice.start();
  }

  addRemoteCandidate(cand: { address: string; port: number; type?: string; priority?: number }): void {
    this.ice.addRemoteCandidate(cand);
  }

  private _startDtls(): void {
    if (this._dtlsStarted) return;
    this._dtlsStarted = true;

    this.dtls = new DtlsConnection({
      role: this._opts.dtlsRole === 'client' ? DTLS_ROLE.CLIENT : DTLS_ROLE.SERVER,
      certDer: this._opts.certDer,
      privateKey: this._opts.privateKey,
      verifyFingerprint: this._opts.verifyFingerprint,
      output: (datagram: Buffer) => {
        try { this.ice.send(datagram); } catch (e) { this.emit('error', e); }
      },
    });

    this.dtls.on('connect', () => {
      this.emit('dtlsconnected');
      this._startSctp();
    });
    this.dtls.on('data', (record: Buffer) => {
      if (this.sctp) this.sctp.receivePacket(record);
    });
    this.dtls.on('error', (e) => this.emit('error', e));
    this.dtls.on('close', () => this.emit('close'));

    this.dtls.start();
  }

  private _startSctp(): void {
    const isClient = this._opts.dtlsRole === 'client';
    const sctp = new SctpAssociation({ isClient });
    this.sctp = sctp;
    sctp.on('output', (pkt: Buffer) => {
      try { if (this.dtls) this.dtls.send(pkt); } catch (e) { this.emit('error', e); }
    });
    sctp.on('error', (e) => this.emit('error', e));
    sctp.on('close', () => this.emit('close'));

    this.dcm = new DataChannelManager(sctp, isClient);
    this.dcm.on('open-request', (info: OpenRequestInfo) => this.emit('datachannel-request', info));

    sctp.on('established', () => {
      this.emit('sctpconnected');
      this.emit('ready');
    });

    sctp.start();
  }

  /** Open a locally-initiated data channel once SCTP is established. */
  openChannel(channel: RTCDataChannel, init: RTCDataChannelInit): void {
    if (!this.dcm) throw new Error('SCTP not ready');
    this.dcm.openChannel(channel, init);
  }

  /** Accept an inbound channel created from a 'datachannel-request'. */
  acceptChannel(channel: RTCDataChannel, info: OpenRequestInfo): void {
    if (!this.dcm) throw new Error('SCTP not ready');
    this.dcm.acceptChannel(channel, info);
  }

  isReady(): boolean {
    return !!this.sctp && this.sctp.state === 'established';
  }

  close(): void {
    if (this.sctp) try { this.sctp.shutdown(); } catch { /* best-effort */ }
    if (this.dtls) try { this.dtls.close(); } catch { /* best-effort */ }
    if (this.ice) try { this.ice.close(); } catch { /* best-effort */ }
  }
}
