/**
 * @file node-to-node.ts
 * @description Two NodeRTC peers in one process establish a real WebRTC data
 * channel (ICE + DTLS + SCTP) through a TURN server and exchange string and
 * binary messages.
 *
 * This is the simplest way to see the full stack work without a browser. The
 * two peers exchange offer/answer and ICE candidates directly via function
 * calls (standing in for a signaling channel).
 *
 * Both peers are configured with a TURN server. Point them at your own server
 * via env vars; the defaults match the coturn used by the test suite:
 *
 *   TURN_URL    turn:127.0.0.1:3478   (use turns:host:5349 for TLS/DTLS)
 *   TURN_USER   testuser
 *   TURN_PASS   testpass
 *   RELAY_ONLY  unset                 (set to 1 to force traffic via the relay)
 *
 * Run a local coturn first (or set the env vars to a reachable server):
 *
 *   docker run -d -p 3478:3478/udp coturn/coturn -n --listening-port=3478 \
 *     --lt-cred-mech --user=testuser:testpass --realm=nodertc.local \
 *     --no-tls --no-dtls --fingerprint
 *
 *   node examples/node-to-node.ts
 */

'use strict';

import { RTCPeerConnection } from '../src/index';

async function main() {
  // TURN server configuration (override via env). Both peers gather relay
  // candidates from this server; with RELAY_ONLY the data path is forced
  // through the relay (iceTransportPolicy: 'relay').
  const iceServers = [
    {
      urls: process.env.TURN_URL || 'turn:127.0.0.1:3478',
      username: process.env.TURN_USER || 'testuser',
      credential: process.env.TURN_PASS || 'testpass',
    },
  ];
  const iceTransportPolicy = process.env.RELAY_ONLY ? 'relay' as const : 'all' as const;

  console.log(`Using TURN server: ${iceServers[0]!.urls} (policy: ${iceTransportPolicy})`);

  const offerer = new RTCPeerConnection({ iceServers, iceTransportPolicy });
  const answerer = new RTCPeerConnection({ iceServers, iceTransportPolicy });

  // Trickle ICE candidates between the peers (here, a direct call).
  offerer.on('icecandidate', (e: any) => { if (e.candidate) answerer.addIceCandidate(e.candidate); });
  answerer.on('icecandidate', (e: any) => { if (e.candidate) offerer.addIceCandidate(e.candidate); });

  offerer.on('connectionstatechange', () =>
    console.log(`[offerer] connection: ${offerer.connectionState}`));

  // Offerer creates the channel.
  const channel = offerer.createDataChannel('demo', { ordered: true });

  channel.on('open', () => {
    console.log('[offerer] channel open — sending messages');
    channel.send('hello over real WebRTC');
    channel.send(Uint8Array.from([1, 2, 3, 4, 5]).buffer); // binary
  });
  channel.on('message', (e: any) => {
    const text = typeof e.data === 'string' ? e.data : `<binary ${Buffer.from(e.data).length} bytes>`;
    console.log(`[offerer] received: ${text}`);
  });

  // Answerer receives the channel.
  answerer.on('datachannel', ({ channel: ch }: any) => {
    ch.binaryType = 'arraybuffer';
    console.log(`[answerer] got data channel: ${ch.label}`);
    ch.on('message', (e: any) => {
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
