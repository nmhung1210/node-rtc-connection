/**
 * @file browser-server.js
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
 *   node examples/browser-server.js
 *   # then open http://localhost:3000 in a browser
 *
 * Each browser tab gets its own independent Node-side peer connection.
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { RTCPeerConnection } = require('../src/index.js');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const CLIENT_HTML = fs.readFileSync(path.join(__dirname, 'browser-client.html'), 'utf8');

// One Node-side peer + its pending offer, keyed by a session id the browser
// generates. This lets multiple tabs connect independently.
const sessions = new Map();

/** Fold this peer's gathered ICE candidates into its local SDP. */
function localDescriptionWithCandidates(pc, candidates) {
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
  const pc = new RTCPeerConnection();
  const candidates = [];

  const session = { pc, channel: null, offer: null, connected: false };

  // We are the offerer: create the data channel.
  const channel = pc.createDataChannel('chat', { ordered: true });
  session.channel = channel;

  channel.on('open', () => {
    console.log('[node] data channel open — sending greeting');
    channel.send('👋 Hello from the Node.js server!');
  });
  channel.on('message', (e) => {
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

  // Gather all candidates, then build the offer SDP that embeds them.
  const gathered = new Promise((resolve) => {
    pc.on('icecandidate', (e) => {
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

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(CLIENT_HTML);
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
  } catch (err) {
    console.error('[node] error handling request:', err);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log('=== NodeRTC: Node.js <-> Browser data channel demo ===');
  console.log(`Open http://localhost:${PORT} in your browser, then watch both`);
  console.log('this console and the browser page exchange messages.\n');
});
