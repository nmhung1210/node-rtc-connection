/**
 * @file interop-server.js
 * @description Browser interop harness. Node runs our RTCPeerConnection as the
 * offerer; a headless browser runs a native RTCPeerConnection as the answerer.
 * SDP and ICE candidates are exchanged over HTTP (non-trickle: candidates are
 * folded into the SDP once gathering completes). The browser opens the data
 * channel echo and reports success back to /result.
 *
 * Run: node test/browser/interop-server.js  (then point a browser at /)
 * The companion runner (run-browser-interop.js) launches headless Chrome.
 */

'use strict';

const http = require('http');
const { RTCPeerConnection } = require('../../src/index.js');

const PORT = process.env.INTEROP_PORT ? parseInt(process.env.INTEROP_PORT, 10) : 0;

/** Fold gathered candidates into an SDP's media section. */
function withCandidates(sdp, candidates) {
  const lines = sdp.replace(/\r\n$/, '').split('\r\n');
  const out = [];
  for (const line of lines) {
    out.push(line);
  }
  // Append candidate lines after the last a= line of the m-section.
  for (const c of candidates) {
    out.push('a=' + (c.candidate.startsWith('candidate:') ? c.candidate : 'candidate:' + c.candidate));
  }
  out.push('a=end-of-candidates');
  return out.join('\r\n') + '\r\n';
}

async function createOfferWithCandidates(pc) {
  const candidates = [];
  const done = new Promise((resolve) => {
    pc.on('icecandidate', (e) => {
      if (e.candidate) candidates.push(e.candidate);
      else resolve();
    });
  });
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await done;
  return { type: 'offer', sdp: withCandidates(pc.localDescription.sdp, candidates) };
}

function startServer(onResult) {
  const pc = new RTCPeerConnection();
  const state = { resolved: false };

  // Our local data channel (we are the offerer).
  const channel = pc.createDataChannel('interop', { ordered: true });
  channel.on('open', () => {
    channel.send('hello-from-node');
  });
  channel.on('message', (e) => {
    const data = typeof e.data === 'string' ? e.data : '[binary ' + Buffer.from(e.data).length + ']';
    onResult({ event: 'node-received', data });
  });

  pc.on('connectionstatechange', () => {
    onResult({ event: 'node-state', state: pc.connectionState });
  });

  let offerPromise = null;

  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html', ...cors });
      res.end(PAGE);
      return;
    }

    if (req.url === '/offer') {
      if (!offerPromise) offerPromise = createOfferWithCandidates(pc);
      const offer = await offerPromise;
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(offer));
      return;
    }

    if (req.url === '/answer' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const answer = JSON.parse(body);
          await pc.setRemoteDescription(answer);
          res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          onResult({ event: 'error', error: err.message });
          res.writeHead(500, cors);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.url === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try { onResult(JSON.parse(body)); } catch (_) {}
        res.writeHead(200, cors);
        res.end('{}');
      });
      return;
    }

    res.writeHead(404, cors);
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      resolve({ server, pc, channel, port: server.address().port });
    });
  });
}

// Browser-side page: native RTCPeerConnection as the answerer.
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>interop</title></head>
<body><script>
(async () => {
  const report = (obj) => fetch('/result', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(obj)});
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onconnectionstatechange = () => report({event:'browser-state', state: pc.connectionState});
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      ch.onopen = () => report({event:'browser-channel-open', label: ch.label});
      ch.onmessage = (m) => {
        report({event:'browser-received', data: (typeof m.data==='string')? m.data : '[binary]'});
        // Echo back, then send a binary frame to exercise that path.
        ch.send('hello-from-browser');
        const buf = new Uint8Array([1,2,3,4,5]); ch.send(buf.buffer);
      };
    };

    const offer = await (await fetch('/offer')).json();
    await pc.setRemoteDescription(offer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // Wait for ICE gathering to complete so candidates are in the SDP.
    await new Promise((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') res(); };
      setTimeout(res, 3000);
    });
    await fetch('/answer', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pc.localDescription)});
    report({event:'browser-answer-sent'});
  } catch (e) {
    report({event:'browser-error', error: String(e)});
  }
})();
</script></body></html>`;

module.exports = { startServer };

// Allow standalone run for manual testing.
if (require.main === module) {
  startServer((r) => console.log('[result]', JSON.stringify(r))).then(({ port }) => {
    console.log(`Interop server on http://127.0.0.1:${port}`);
  });
}
