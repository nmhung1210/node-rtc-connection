/**
 * @file node-to-node.js
 * @description Two NodeRTC peers in one process establish a real WebRTC data
 * channel (ICE + DTLS + SCTP over UDP) and exchange string and binary messages.
 *
 * This is the simplest way to see the full stack work without a browser. The
 * two peers exchange offer/answer and ICE candidates directly via function
 * calls (standing in for a signaling channel).
 *
 *   node examples/node-to-node.js
 */

'use strict';

const { RTCPeerConnection } = require('../src/index.js');

async function main() {
  const offerer = new RTCPeerConnection();
  const answerer = new RTCPeerConnection();

  // Trickle ICE candidates between the peers (here, a direct call).
  offerer.on('icecandidate', (e) => { if (e.candidate) answerer.addIceCandidate(e.candidate); });
  answerer.on('icecandidate', (e) => { if (e.candidate) offerer.addIceCandidate(e.candidate); });

  offerer.on('connectionstatechange', () =>
    console.log(`[offerer] connection: ${offerer.connectionState}`));

  // Offerer creates the channel.
  const channel = offerer.createDataChannel('demo', { ordered: true });

  channel.on('open', () => {
    console.log('[offerer] channel open — sending messages');
    channel.send('hello over real WebRTC');
    channel.send(Uint8Array.from([1, 2, 3, 4, 5]).buffer); // binary
  });
  channel.on('message', (e) => {
    const text = typeof e.data === 'string' ? e.data : `<binary ${Buffer.from(e.data).length} bytes>`;
    console.log(`[offerer] received: ${text}`);
  });

  // Answerer receives the channel.
  answerer.on('datachannel', ({ channel: ch }) => {
    ch.binaryType = 'arraybuffer';
    console.log(`[answerer] got data channel: ${ch.label}`);
    ch.on('message', (e) => {
      if (typeof e.data === 'string') {
        console.log(`[answerer] received string: ${e.data}`);
        ch.send(`reply: ${e.data}`);
      } else {
        console.log(`[answerer] received binary: ${Buffer.from(e.data).length} bytes`);
        cleanup();
      }
    });
  });

  // Offer / answer exchange.
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await answerer.setRemoteDescription(offer);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await offerer.setRemoteDescription(answer);

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    setTimeout(() => {
      offerer.close();
      answerer.close();
      console.log('\nDone. Closed both peers.');
      process.exit(0);
    }, 200);
  }

  // Safety timeout.
  setTimeout(() => {
    console.error('Timed out before completing the exchange.');
    offerer.close();
    answerer.close();
    process.exit(1);
  }, 10000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
