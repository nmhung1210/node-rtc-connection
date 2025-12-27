/**
 * @file browser-node-connection.js
 * @description Example showing Node.js peer connecting to a browser
 * 
 * This demonstrates:
 * 1. Node.js creates a peer connection
 * 2. Node.js creates an offer
 * 3. Browser receives offer and creates answer
 * 4. Peers exchange ICE candidates
 * 5. Data channel opens and messages are exchanged
 */

const { RTCPeerConnection } = require('../src/index.js');
const http = require('http');
const fs = require('fs');
const path = require('path');

// Load peer configuration
const configPath = path.join(__dirname, 'peer.config.json');
const peerConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// Create HTTP server to serve the browser page
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    // Serve HTML page
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getHTML());
  } else if (req.url === '/offer') {
    // Browser requests the Node.js offer
    handleOfferRequest(req, res);
  } else if (req.url.startsWith('/answer')) {
    // Browser sends its answer
    handleAnswerRequest(req, res);
  } else if (req.url.startsWith('/candidate')) {
    // Exchange ICE candidates
    handleCandidateRequest(req, res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// Store peer connection and signaling data
let nodePeerConnection = null;
let nodeOffer = null;
let nodeCandidates = [];
let browserCandidates = [];

async function createNodePeer() {
  // Create peer connection
  console.log('Creating Node.js peer with configuration:', peerConfig.default.iceServers.map(s => s.urls).flat());
  nodePeerConnection = new RTCPeerConnection(peerConfig.default);

  // Create data channel
  const channel = nodePeerConnection.createDataChannel('chat', {
    ordered: true
  });

  console.log('Created data channel:', channel.label);

  // Setup channel events
  channel.on('open', () => {
    console.log('✓ Data channel opened!');
    channel.send('Hello from Node.js!');
  });

  channel.on('message', (event) => {
    console.log('Received from browser:', event.data.toString());
    // Echo back
    channel.send(`Node.js echo: ${event.data}`);
  });

  channel.on('close', () => {
    console.log('Data channel closed');
  });

  // Setup peer connection events
  nodePeerConnection.on('icecandidate', (event) => {
    if (event.candidate) {
      console.log('Node.js ICE candidate:', event.candidate.candidate);
      nodeCandidates.push(event.candidate);
    }
  });

  nodePeerConnection.on('connectionstatechange', () => {
    console.log('Connection state:', nodePeerConnection.connectionState);
  });

  nodePeerConnection.on('icegatheringstatechange', () => {
    console.log('ICE gathering state:', nodePeerConnection.iceGatheringState);
  });

  // Create offer
  console.log('Creating offer...');
  nodeOffer = await nodePeerConnection.createOffer();
  await nodePeerConnection.setLocalDescription(nodeOffer);
  console.log('✓ Offer created');
}

function handleOfferRequest(req, res) {
  if (!nodeOffer) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Offer not ready yet' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify({
    offer: nodeOffer.toJSON(),
    candidates: nodeCandidates
  }));
}

function handleAnswerRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { answer, candidates } = JSON.parse(body);
      
      console.log('Received answer from browser');
      await nodePeerConnection.setRemoteDescription(answer);
      
      // Add browser candidates
      for (const candidate of candidates) {
        if (candidate) {
          await nodePeerConnection.addIceCandidate(candidate);
        }
      }
      
      console.log('✓ Answer set, connection establishing...');
      
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (error) {
      console.error('Error handling answer:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function handleCandidateRequest(req, res) {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { candidate } = JSON.parse(body);
      if (candidate && nodePeerConnection) {
        await nodePeerConnection.addIceCandidate(candidate);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ status: 'ok' }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message }));
    }
  });
}

function getHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Browser ↔ Node.js WebRTC Connection</title>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 {
      color: #333;
      border-bottom: 3px solid #4CAF50;
      padding-bottom: 10px;
    }
    .status {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .status-item {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #eee;
    }
    .status-item:last-child {
      border-bottom: none;
    }
    .status-value {
      font-weight: bold;
      color: #4CAF50;
    }
    #messages {
      background: white;
      border-radius: 8px;
      padding: 20px;
      min-height: 200px;
      max-height: 400px;
      overflow-y: auto;
      margin: 20px 0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .message {
      padding: 8px;
      margin: 5px 0;
      border-radius: 4px;
    }
    .message.received {
      background: #E3F2FD;
      color: #1976D2;
    }
    .message.sent {
      background: #F3E5F5;
      color: #7B1FA2;
      text-align: right;
    }
    .message.system {
      background: #FFF3E0;
      color: #E65100;
      font-style: italic;
    }
    .controls {
      background: white;
      border-radius: 8px;
      padding: 20px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    input[type="text"] {
      flex: 1;
      padding: 10px;
      border: 2px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    button {
      padding: 10px 20px;
      background: #4CAF50;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      margin-left: 10px;
    }
    button:hover {
      background: #45a049;
    }
    button:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .input-group {
      display: flex;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <h1>🌐 Browser ↔ Node.js WebRTC Connection</h1>
  
  <div class="status">
    <h3>Connection Status</h3>
    <div class="status-item">
      <span>Signaling State:</span>
      <span class="status-value" id="signalingState">-</span>
    </div>
    <div class="status-item">
      <span>ICE Connection State:</span>
      <span class="status-value" id="iceConnectionState">-</span>
    </div>
    <div class="status-item">
      <span>Connection State:</span>
      <span class="status-value" id="connectionState">-</span>
    </div>
    <div class="status-item">
      <span>Data Channel State:</span>
      <span class="status-value" id="channelState">-</span>
    </div>
  </div>

  <div id="messages">
    <div class="message system">Click "Connect" to establish connection with Node.js peer...</div>
  </div>

  <div class="controls">
    <button id="connectBtn" onclick="connect()">Connect to Node.js</button>
    <div class="input-group">
      <input type="text" id="messageInput" placeholder="Type a message..." disabled>
      <button id="sendBtn" onclick="sendMessage()" disabled>Send</button>
    </div>
  </div>

  <script>
    let pc = null;
    let channel = null;
    const messages = document.getElementById('messages');

    function addMessage(text, type = 'system') {
      const div = document.createElement('div');
      div.className = 'message ' + type;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function updateStatus() {
      if (pc) {
        document.getElementById('signalingState').textContent = pc.signalingState;
        document.getElementById('iceConnectionState').textContent = pc.iceConnectionState;
        document.getElementById('connectionState').textContent = pc.connectionState;
      }
      if (channel) {
        document.getElementById('channelState').textContent = channel.readyState;
      }
    }

    async function connect() {
      try {
        addMessage('Fetching offer from Node.js...', 'system');
        
        // Fetch offer from Node.js
        const offerResponse = await fetch('/offer');
        const { offer, candidates: nodeCandidates } = await offerResponse.json();
        
        addMessage('✓ Received offer from Node.js', 'system');

        // Create peer connection
        pc = new RTCPeerConnection(peerConfig.default);
        
        // Setup event handlers
        pc.onicecandidate = (event) => {
          if (event.candidate) {
            console.log('Browser ICE candidate:', event.candidate);
          }
        };

        pc.onconnectionstatechange = () => {
          console.log('Connection state:', pc.connectionState);
          updateStatus();
        };

        pc.onsignalingstatechange = updateStatus;
        pc.oniceconnectionstatechange = updateStatus;

        pc.ondatachannel = (event) => {
          channel = event.channel;
          addMessage('✓ Data channel received: ' + channel.label, 'system');
          setupChannel();
          updateStatus();
        };

        // Set remote description (Node.js offer)
        await pc.setRemoteDescription(offer);
        addMessage('✓ Set remote description', 'system');

        // Add Node.js candidates
        for (const candidate of nodeCandidates) {
          if (candidate) {
            await pc.addIceCandidate(candidate);
          }
        }

        // Create answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        addMessage('✓ Created answer', 'system');

        // Wait a bit for ICE candidates
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Get local candidates
        const browserCandidates = [];
        // Note: In real implementation, candidates would be gathered via onicecandidate

        // Send answer to Node.js
        await fetch('/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            answer: pc.localDescription,
            candidates: browserCandidates
          })
        });

        addMessage('✓ Sent answer to Node.js', 'system');
        addMessage('Waiting for data channel to open...', 'system');

        document.getElementById('connectBtn').disabled = true;

      } catch (error) {
        addMessage('✗ Error: ' + error.message, 'system');
        console.error('Connection error:', error);
      }
    }

    function setupChannel() {
      channel.onopen = () => {
        addMessage('✓ Data channel opened!', 'system');
        document.getElementById('messageInput').disabled = false;
        document.getElementById('sendBtn').disabled = false;
        updateStatus();
      };

      channel.onmessage = (event) => {
        addMessage(event.data, 'received');
      };

      channel.onclose = () => {
        addMessage('Data channel closed', 'system');
        document.getElementById('messageInput').disabled = true;
        document.getElementById('sendBtn').disabled = true;
        updateStatus();
      };

      channel.onerror = (error) => {
        addMessage('Channel error: ' + error, 'system');
      };
    }

    function sendMessage() {
      const input = document.getElementById('messageInput');
      const message = input.value.trim();
      
      if (message && channel && channel.readyState === 'open') {
        channel.send(message);
        addMessage(message, 'sent');
        input.value = '';
      }
    }

    document.getElementById('messageInput').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      }
    });

    updateStatus();
  </script>
</body>
</html>`;
}

// Start server
const PORT = 3000;

async function start() {
  console.log('=== Node.js WebRTC Peer ===\n');
  
  // Create Node.js peer connection
  await createNodePeer();
  
  // Start HTTP server
  server.listen(PORT, () => {
    console.log(`\n✓ Server running at http://localhost:${PORT}`);
    console.log('\nOpen your browser and navigate to:');
    console.log(`  http://localhost:${PORT}\n`);
    console.log('Then click "Connect to Node.js" to establish the connection.\n');
  });
}

start().catch(console.error);
