/**
 * @file interop-server.ts
 * @description Browser interop harness for the Playwright-driven e2e tests.
 *
 * Node runs our RTCPeerConnection as the OFFERER and owns the data channel; a
 * browser runs a native RTCPeerConnection as the ANSWERER. SDP + ICE candidates
 * are exchanged over HTTP (non-trickle: candidates are folded into the SDP once
 * gathering completes).
 *
 * Data verification: Node sends a fixed sequence of payloads (ASCII, Unicode,
 * binary with edge bytes, a large binary that forces SCTP fragmentation, and a
 * large string). The browser echoes each message back verbatim, preserving
 * string-vs-binary. Node compares every echo byte-for-byte and reports the
 * result, so the test proves correct data transfer, not just "something
 * arrived".
 *
 * Both the Node peer and the browser peer are configurable (iceServers /
 * iceTransportPolicy) so the same harness covers direct (no TURN) and
 * relay-only (TURN) network modes.
 */

'use strict';

import * as http from 'http';
import * as crypto from 'crypto';
import { RTCPeerConnection } from '../../src/index';

/**
 * The payloads Node sends; the browser echoes each one back unchanged.
 * `kind` drives how Node sends it and how it validates the echo.
 */
export function buildPayloads() {
  const bigBinary = Buffer.alloc(16384);
  for (let i = 0; i < bigBinary.length; i++) bigBinary[i] = i & 0xff;
  return [
    { id: 'ascii', kind: 'string', value: 'hello-from-node' },
    { id: 'unicode', kind: 'string', value: 'héllo 世界 🌐   end' },
    { id: 'binary-small', kind: 'binary', value: Buffer.from([0, 1, 2, 254, 255, 128, 42, 0]) },
    { id: 'binary-large', kind: 'binary', value: bigBinary }, // forces SCTP fragmentation
    { id: 'string-large', kind: 'string', value: 'x'.repeat(10240) },
  ];
}

/** Fold gathered candidates into an SDP's media section. */
function withCandidates(sdp: string, candidates: any[]) {
  const lines = sdp.replace(/\r\n$/, '').split('\r\n');
  for (const c of candidates) {
    lines.push('a=' + (c.candidate.startsWith('candidate:') ? c.candidate : 'candidate:' + c.candidate));
  }
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}

async function createOfferWithCandidates(pc: any) {
  const candidates: any[] = [];
  const done = new Promise<void>((resolve) => {
    pc.on('icecandidate', (e: any) => {
      if (e.candidate) candidates.push(e.candidate);
      else resolve();
    });
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await done;
  return { type: 'offer', sdp: withCandidates(pc.localDescription.sdp, candidates) };
}

/**
 * Start the harness.
 * @param {Object} opts
 * @param {(r:Object)=>void} opts.onResult - event sink (channel-open, echo
 *   verification per payload, done, error).
 * @param {Object} [opts.nodeConfig] - RTCConfiguration for the Node peer.
 * @param {Object} [opts.browserConfig] - RTCConfiguration injected into the page.
 * @returns {Promise<{server, pc, channel, port}>}
 */
export function startServer(opts: any) {
  const onResult = typeof opts === 'function' ? opts : opts.onResult;
  const nodeConfig = (opts && opts.nodeConfig) || {};
  const browserConfig = (opts && opts.browserConfig) || { iceServers: [] };
  const port = (opts && opts.port) || 0;

  const pc = new RTCPeerConnection(nodeConfig);
  const payloads = buildPayloads();
  let index = -1;

  const channel = pc.createDataChannel('interop', { ordered: true });

  function sendNext() {
    index += 1;
    if (index >= payloads.length) {
      onResult({ event: 'done' });
      return;
    }
    const p = payloads[index];
    channel.send(p.kind === 'string' ? p.value : p.value);
  }

  channel.on('open', () => {
    onResult({ event: 'channel-open' });
    sendNext();
  });

  // Each browser echo is validated byte-for-byte against the payload we sent.
  channel.on('message', (e: any) => {
    const expected = payloads[index];
    let ok = false;
    let detail = '';
    if (!expected) {
      detail = 'unexpected message after sequence end';
    } else if (expected.kind === 'string') {
      ok = typeof e.data === 'string' && e.data === expected.value;
      detail = ok ? '' : `string mismatch (got ${typeof e.data}, len ${e.data && e.data.length})`;
    } else {
      const got = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
      ok = got.length === (expected.value as Buffer).length && got.equals(expected.value as Buffer);
      detail = ok ? '' : `binary mismatch (got ${got.length}B, want ${(expected.value as Buffer).length}B)`;
    }
    onResult({ event: 'echo', id: expected ? expected.id : '?', ok, detail });
    if (ok) sendNext();
    else onResult({ event: 'done' });
  });

  pc.on('connectionstatechange', () => onResult({ event: 'node-state', state: pc.connectionState }));

  let offerPromise: Promise<any> | null = null;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...cors });
      res.end(renderPage(browserConfig));
      return;
    }
    if (req.url === '/offer') {
      if (!offerPromise) offerPromise = createOfferWithCandidates(pc);
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(await offerPromise));
      return;
    }
    if (req.url === '/answer' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          await pc.setRemoteDescription(JSON.parse(body));
          res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: any) {
          onResult({ event: 'error', error: err.message });
          res.writeHead(500, cors); res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
    if (req.url === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => { try { onResult(JSON.parse(body)); } catch (_) {} res.writeHead(200, cors); res.end('{}'); });
      return;
    }
    res.writeHead(404, cors); res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, pc, channel, port: (server.address() as any).port });
    });
  });
}

/**
 * Browser-side page: native RTCPeerConnection answerer that echoes every
 * message back verbatim, preserving string-vs-binary.
 */
function renderPage(browserConfig: any) {
  const cfg = JSON.stringify(browserConfig);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>interop</title></head>
<body><script>
(async () => {
  const report = (o) => fetch('/result', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
  try {
    const pc = new RTCPeerConnection(${cfg});
    pc.onconnectionstatechange = () => report({event:'browser-state', state: pc.connectionState});
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.binaryType = 'arraybuffer';
      ch.onopen = () => report({event:'browser-channel-open', label: ch.label});
      ch.onmessage = (m) => {
        // Echo verbatim, preserving type so Node can byte-compare.
        if (typeof m.data === 'string') ch.send(m.data);
        else ch.send(m.data); // ArrayBuffer
      };
    };

    const offer = await (await fetch('/offer')).json();
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') res(); };
      setTimeout(res, 5000);
    });
    await fetch('/answer', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pc.localDescription)});
    report({event:'browser-answer-sent'});
  } catch (e) {
    report({event:'browser-error', error: String(e)});
  }
})();
</script></body></html>`;
}

// Standalone manual run.
if (require.main === module) {
  (startServer((r: any) => console.log('[result]', JSON.stringify(r))) as Promise<any>).then(({ port }) => {
    console.log(`Interop server on http://127.0.0.1:${port}`);
  });
}
