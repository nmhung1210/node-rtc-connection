/**
 * @file sdp-utils.ts
 * @description SDP generation/parsing for a WebRTC data-channel m-section.
 * @module sdp/sdp-utils
 *
 * Emits the standard application m-line with the SCTP-over-DTLS profile and
 * conveys transport addresses through ICE candidates (not the c=/m= lines, per
 * the WebRTC JSEP/SDP rules). This is what browsers expect.
 */

'use strict';

import * as crypto from 'crypto';

/** ICE credentials. */
export interface IceCredentials {
  usernameFragment: string;
  password: string;
}

/** DTLS certificate fingerprint. */
export interface Fingerprint {
  algorithm: string;
  value: string;
}

/** A candidate descriptor as accepted by {@link buildSdp}. */
export interface CandidateInput {
  sdp?: string;
  candidate?: string;
}

/** Options accepted by {@link buildSdp}. */
export interface BuildSdpOptions {
  kind?: 'offer' | 'answer';
  iceUfrag: string;
  icePwd: string;
  fingerprint?: Fingerprint;
  setup?: string;
  candidates?: CandidateInput[];
  sctpPort?: number;
  maxMessageSize?: number;
}

/** Options accepted by {@link generateOffer} / {@link generateAnswer}. */
export interface GenerateOptions extends BuildSdpOptions {}

/** Parsed ICE parameters. */
export interface IceParameters {
  usernameFragment: string | null;
  password: string | null;
}

/** Parsed DTLS parameters. */
export interface DtlsParameters {
  role: string;
  fingerprints: Fingerprint[];
  setup?: string;
}

/** Parsed SCTP parameters. */
export interface SctpParameters {
  port: number;
  maxMessageSize: number;
}

/** A parsed ICE candidate. */
export interface ParsedCandidate {
  candidate: string;
  foundation: string;
  component: number;
  protocol: string;
  priority: number;
  address: string;
  port: number;
  type: string;
}

/**
 * Generate ICE credentials (ufrag >= 4 chars, pwd >= 22 chars per RFC 8445).
 * @returns {{usernameFragment:string, password:string}}
 */
export function generateIceCredentials(): IceCredentials {
  return {
    usernameFragment: crypto.randomBytes(3).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).padEnd(4, 'x'),
    password: crypto.randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 24).padEnd(24, 'x'),
  };
}

/**
 * Build the SDP for a data-channel-only session.
 * @param {Object} o
 * @param {'offer'|'answer'} o.kind
 * @param {string} o.iceUfrag
 * @param {string} o.icePwd
 * @param {{algorithm:string,value:string}} o.fingerprint - DTLS cert fingerprint
 * @param {string} o.setup - 'actpass' | 'active' | 'passive'
 * @param {Array<{sdp?:string,candidate?:string}>} [o.candidates]
 * @param {number} [o.sctpPort=5000]
 * @param {number} [o.maxMessageSize=262144]
 * @returns {string}
 */
export function buildSdp(o: BuildSdpOptions): string {
  const {
    iceUfrag,
    icePwd,
    fingerprint,
    setup = 'actpass',
    candidates = [],
    sctpPort = 5000,
    maxMessageSize = 262144,
  } = o;

  const lines: string[] = [];
  lines.push('v=0');
  // Session id is arbitrary; use random to avoid Date.now noise.
  const sessId = crypto.randomBytes(4).readUInt32BE(0);
  lines.push(`o=- ${sessId} 2 IN IP4 127.0.0.1`);
  lines.push('s=-');
  lines.push('t=0 0');
  lines.push('a=group:BUNDLE 0');
  lines.push('a=msid-semantic: WMS');

  // The port in the m-line is the standard placeholder 9; addresses come from
  // ICE candidates. Proto reflects the real transport: DTLS/SCTP.
  lines.push('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
  lines.push('c=IN IP4 0.0.0.0');
  lines.push('a=ice-ufrag:' + iceUfrag);
  lines.push('a=ice-pwd:' + icePwd);
  lines.push('a=ice-options:trickle');
  if (fingerprint) {
    lines.push(`a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`);
  }
  lines.push(`a=setup:${setup}`);
  lines.push('a=mid:0');
  lines.push('a=sctp-port:' + sctpPort);
  lines.push('a=max-message-size:' + maxMessageSize);

  for (const c of candidates) {
    const cstr = c.sdp || c.candidate;
    if (cstr) lines.push('a=' + (cstr.startsWith('candidate:') ? cstr : 'candidate:' + cstr));
  }

  return lines.join('\r\n') + '\r\n';
}

export function generateOffer(opts: GenerateOptions): string {
  return buildSdp({ ...opts, kind: 'offer', setup: opts.setup || 'actpass' });
}

export function generateAnswer(opts: GenerateOptions): string {
  return buildSdp({ ...opts, kind: 'answer', setup: opts.setup || 'active' });
}

/** Parse ICE ufrag/pwd. */
export function parseIceParameters(sdp: string): IceParameters {
  const params: IceParameters = { usernameFragment: null, password: null };
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=ice-ufrag:')) params.usernameFragment = line.slice(12).trim();
    else if (line.startsWith('a=ice-pwd:')) params.password = line.slice(10).trim();
  }
  return params;
}

/** Parse DTLS setup role + fingerprints. */
export function parseDtlsParameters(sdp: string): DtlsParameters {
  const params: DtlsParameters = { role: 'auto', fingerprints: [] };
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=setup:')) {
      const setup = line.slice(8).trim();
      if (setup === 'active') params.role = 'client';
      else if (setup === 'passive') params.role = 'server';
      else params.role = 'actpass';
      params.setup = setup;
    } else if (line.startsWith('a=fingerprint:')) {
      const parts = line.slice(14).trim().split(/\s+/);
      if (parts.length === 2) {
        params.fingerprints.push({ algorithm: parts[0]!.toLowerCase(), value: parts[1]!.toUpperCase() });
      }
    }
  }
  return params;
}

/** Parse SCTP port / max message size. */
export function parseSctpParameters(sdp: string): SctpParameters {
  const params: SctpParameters = { port: 5000, maxMessageSize: 262144 };
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('a=sctp-port:')) params.port = parseInt(line.slice(12), 10);
    else if (line.startsWith('a=max-message-size:')) params.maxMessageSize = parseInt(line.slice(19), 10);
  }
  return params;
}

/**
 * Parse ICE candidate lines into structured objects.
 * @param {string} sdp
 * @returns {Array<{candidate:string,foundation:string,component:number,protocol:string,priority:number,address:string,port:number,type:string}>}
 */
export function parseCandidates(sdp: string): ParsedCandidate[] {
  const out: ParsedCandidate[] = [];
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=candidate:')) continue;
    const c = parseCandidateLine(line.slice(2));
    if (c) out.push(c);
  }
  return out;
}

/**
 * Parse a single "candidate:..." string.
 * @param {string} str
 */
export function parseCandidateLine(str: string): ParsedCandidate | null {
  // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> ...
  const s = str.startsWith('candidate:') ? str.slice('candidate:'.length) : str;
  const t = s.split(/\s+/);
  if (t.length < 8) return null;
  return {
    candidate: str.startsWith('candidate:') ? str : 'candidate:' + str,
    foundation: t[0]!,
    component: parseInt(t[1]!, 10),
    protocol: t[2]!.toLowerCase(),
    priority: parseInt(t[3]!, 10) >>> 0,
    address: t[4]!,
    port: parseInt(t[5]!, 10),
    type: t[7]!,
  };
}
