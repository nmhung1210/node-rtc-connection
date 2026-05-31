/**
 * Helper functions for creating connected peer connections in tests
 */

import { RTCPeerConnection } from '../../src/peerconnection/RTCPeerConnection';

/**
 * Create two connected peer connections with a data channel
 * @param {string} channelLabel - Label for the data channel
 * @returns {Promise<{pc1, pc2, channel1, channel2}>}
 */
export async function createConnectedPeers(channelLabel = 'test') {
  const pc1 = new RTCPeerConnection({ iceServers: [] });
  const pc2 = new RTCPeerConnection({ iceServers: [] });

  const channel1 = pc1.createDataChannel(channelLabel);

  let channel2: any;
  pc2.once('datachannel', ({ channel }: any) => {
    channel2 = channel;
  });

  // Trickle ICE candidates between the peers (the real WebRTC signaling path).
  pc1.on('icecandidate', (e: any) => { if (e.candidate) pc2.addIceCandidate(e.candidate); });
  pc2.on('icecandidate', (e: any) => { if (e.candidate) pc1.addIceCandidate(e.candidate); });

  // Signaling
  const offer = await pc1.createOffer();
  await pc1.setLocalDescription(offer);
  await pc2.setRemoteDescription(offer as any);
  const answer = await pc2.createAnswer();
  await pc2.setLocalDescription(answer);
  await pc1.setRemoteDescription(answer as any);

  // Wait for both channels to open with timeout
  await Promise.race([
    Promise.all([
      new Promise<void>(r => {
        if (channel1.readyState === 'open') r();
        else channel1.once('open', r);
      }),
      new Promise<void>(r => {
        let timeoutId;
        const wait = () => {
          if (channel2 && channel2.readyState === 'open') {
            r();
          } else {
            timeoutId = setTimeout(wait, 10);
          }
        };
        wait();
      })
    ]),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for channels to open')), 5000))
  ]);

  return { pc1, pc2, channel1, channel2 };
}

/**
 * Close peer connections
 */
export function closePeers(pc1: any, pc2: any) {
  if (pc1) pc1.close();
  if (pc2) pc2.close();
}
