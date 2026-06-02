/**
 * @file browser-server.ts
 * @description Real WebRTC between a Node.js server and a browser client.
 *
 * The Node process runs this library's RTCPeerConnection as the OFFERER and
 * creates a data channel. A browser opens the served page, runs its native
 * RTCPeerConnection as the ANSWERER, and the two establish a genuine
 * ICE + DTLS + SCTP data channel over UDP — then exchange chat messages.
 *
 * Signaling here is plain HTTP (offer/answer + ICE candidates). ICE candidates
 * are folded into the SDP once gathering completes (non-trickle), which keeps
 * the signaling trivial. A production app would use WebSockets and trickle ICE.
 *
 * The two peers use DIFFERENT ICE servers, configured from an env file
 * (examples/.env, see examples/.env.example): the Node offerer relays through a
 * TURN server, the browser answerer uses STUN only. They still connect — ICE
 * pairs Node's relay candidate with the browser's server-reflexive (srflx)
 * candidate. With ICE_TRANSPORT_POLICY=relay the Node side is forced through
 * the relay.
 *
 *   TURN_URL                 turn:127.0.0.1:3478  (turns:host:5349 for TLS/DTLS)
 *   TURN_USER                testuser
 *   TURN_PASS                testpass
 *   STUN_URL                 stun:stun.cloudflare.com:3478   (browser side)
 *   ICE_TRANSPORT_POLICY     all | relay   (Node side)
 *   PORT                     3000
 *
 *   cp examples/.env.example examples/.env   # then edit
 *   node examples/browser-server.ts
 *   # then open http://localhost:3000 in a browser
 *
 * Each browser tab gets its own independent Node-side peer connection.
 */

'use strict';

import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { RTCPeerConnection } from '../src/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load examples/.env if present (Node 20.12+ built-in; no dependency). Absent
// file is fine — env vars / defaults below still apply.
const ENV_PATH = path.join(__dirname, '.env');
try {
  if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
} catch (err: any) {
  console.warn(`[node] could not load ${ENV_PATH}: ${err.message}`);
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const CLIENT_HTML = fs.readFileSync(path.join(__dirname, 'browser-client.html'), 'utf8');

// Asymmetric ICE configuration. The two peers do NOT need the same kind of
// server: ICE pairs each peer's candidates against the other's. Here the Node
// peer relays through a TURN server while the browser only uses STUN — the
// working pair is Node's relay candidate ↔ the browser's server-reflexive
// (srflx) candidate. The browser needs STUN (not just host candidates) because
// browsers hide host candidates behind mDNS .local names this library can't
// resolve; a STUN srflx gives Node a concrete address to target.

const ICE_TRANSPORT_POLICY = process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all';

// Node side: TURN (relay). turns:host:5349 for TLS/DTLS.
const NODE_ICE_SERVERS = [
  {
    urls: process.env.TURN_URL || 'turn:127.0.0.1:3478',
    username: process.env.TURN_USER || 'testuser',
    credential: process.env.TURN_PASS || 'testpass',
  },
];

// Browser side: STUN only (served to the page via /config).
const BROWSER_ICE_SERVERS = [
  { urls: process.env.STUN_URL || 'stun:stun.cloudflare.com:3478' },
];

// One Node-side peer + its pending offer, keyed by a session id the browser
// generates. This lets multiple tabs connect independently.
const sessions = new Map();

/** Fold this peer's gathered ICE candidates into its local SDP. */
function localDescriptionWithCandidates(pc: any, candidates: any[]) {
  const sdp = pc.localDescription.sdp.replace(/\r\n$/, '');
  const lines = sdp.split('\r\n');
  for (const c of candidates) {
    const cand = c.candidate.startsWith('candidate:') ? c.candidate : 'candidate:' + c.candidate;
    lines.push('a=' + cand);
  }
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

/** Create a Node-side peer, its data channel, and a ready-to-send offer. */
async function createSession() {
  const pc = new RTCPeerConnection({ iceServers: NODE_ICE_SERVERS, iceTransportPolicy: ICE_TRANSPORT_POLICY });
  const candidates: any[] = [];

  const session = { pc, channel: null as any, offer: null as any, connected: false };

  // We are the offerer: create the data channel.
  const channel = pc.createDataChannel('chat', { ordered: true });
  session.channel = channel;

  channel.on('open', () => {
    console.log('[node] data channel open — sending greeting');
    channel.send('👋 Hello from the Node.js server!');
  });
  channel.on('message', (e: any) => {
    const text = typeof e.data === 'string' ? e.data : `<binary ${Buffer.from(e.data).length} bytes>`;
    console.log(`[node] received: ${text}`);
    // Echo with a server tag so the browser sees a round-trip.
    if (typeof e.data === 'string') channel.send(`server echo: ${e.data}`);
  });
  channel.on('close', () => console.log('[node] data channel closed'));

  pc.on('connectionstatechange', () => {
    console.log(`[node] connection state: ${pc.connectionState}`);
    session.connected = pc.connectionState === 'connected';
  });

  // A peer going away (browser tab closed/refreshed) surfaces as an error
  // (e.g. an SCTP ABORT). Log it and move on — never let it crash the server.
  pc.on('error', (err: any) => {
    console.log(`[node] peer connection error: ${err?.message || err}`);
  });

  // Gather all candidates, then build the offer SDP that embeds them.
  const gathered = new Promise<void>((resolve) => {
    pc.on('icecandidate', (e: any) => {
      if (e.candidate) candidates.push(e.candidate);
      else resolve();
    });
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await gathered;

  session.offer = { type: 'offer', sdp: localDescriptionWithCandidates(pc, candidates) };
  return session;
}

function sendJson(res: any, code: number, obj: any) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req: any) {
  return new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c: any) => (body += c));
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CLIENT_HTML);
      return;
    }

    // Browser fetches its ICE configuration: STUN only. It pairs its srflx
    // candidate with the Node peer's relay candidate. The browser keeps the
    // default 'all' policy so it can offer that srflx (relay-only here would
    // need the browser to have its own TURN server).
    if (url.pathname === '/config') {
      sendJson(res, 200, { iceServers: BROWSER_ICE_SERVERS, iceTransportPolicy: 'all' });
      return;
    }

    // Browser asks for an offer; we mint a fresh session.
    if (url.pathname === '/offer') {
      const id = Math.random().toString(36).slice(2, 10);
      const session = await createSession();
      sessions.set(id, session);
      console.log(`[node] created session ${id}`);
      sendJson(res, 200, { sessionId: id, offer: session.offer });
      return;
    }

    // Browser posts its answer.
    if (url.pathname === '/answer' && req.method === 'POST') {
      const { sessionId, answer } = JSON.parse(await readBody(req));
      const session = sessions.get(sessionId);
      if (!session) return sendJson(res, 404, { error: 'unknown session' });
      await session.pc.setRemoteDescription(answer);
      console.log(`[node] applied answer for session ${sessionId}`);
      sendJson(res, 200, { ok: true });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err: any) {
    console.error('[node] error handling request:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log('=== NodeRTC: Node.js <-> Browser data channel demo ===');
  console.log(`Node TURN: ${NODE_ICE_SERVERS[0]!.urls} (policy: ${ICE_TRANSPORT_POLICY})`);
  console.log(`Browser STUN: ${BROWSER_ICE_SERVERS[0]!.urls}`);
  console.log(`Open http://localhost:${PORT} in your browser, then watch both`);
  console.log('this console and the browser page exchange messages.\n');
});
