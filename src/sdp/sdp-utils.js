/**
 * @file sdp-utils.js
 * @description SDP parsing and generation utilities
 * @module sdp/sdp-utils
 */

'use strict';

/**
 * Generate a simple SDP offer for data channel only
 * @param {Object} options - Generation options
 * @param {string} options.iceUfrag - ICE username fragment
 * @param {string} options.icePwd - ICE password
 * @param {Array<Object>} options.fingerprints - DTLS fingerprints
 * @param {Array<Object>} options.candidates - ICE candidates
 * @param {string} [options.setup='actpass'] - DTLS setup role
 * @param {string} [options.connectionAddress] - Connection IP address
 * @param {number} [options.connectionPort] - Connection port
 * @returns {string} SDP offer
 */
function generateOffer(options) {
  const {
    iceUfrag,
    icePwd,
    fingerprints = [],
    candidates = [],
    setup = 'actpass',
    connectionAddress = '0.0.0.0',
    connectionPort = 9
  } = options;

  const sessionId = Date.now();
  const sessionVersion = 2;
  
  // Get primary fingerprint (SHA-256)
  const fingerprint = fingerprints.find(fp => fp.algorithm === 'sha-256') || fingerprints[0];
  
  let sdp = '';
  
  // Session description
  sdp += 'v=0\r\n';
  sdp += `o=- ${sessionId} ${sessionVersion} IN IP4 ${connectionAddress}\r\n`;
  sdp += 's=-\r\n';
  sdp += 't=0 0\r\n';
  
  // Bundle group (data channel only)
  sdp += 'a=group:BUNDLE 0\r\n';
  sdp += 'a=msid-semantic: WMS\r\n';
  
  // Media description for data channel (application)
  sdp += `m=application ${connectionPort} UDP/DTLS/SCTP webrtc-datachannel\r\n`;
  sdp += `c=IN IP4 ${connectionAddress}\r\n`;
  sdp += 'a=ice-ufrag:' + iceUfrag + '\r\n';
  sdp += 'a=ice-pwd:' + icePwd + '\r\n';
  sdp += 'a=ice-options:trickle\r\n';
  
  // DTLS fingerprint
  if (fingerprint) {
    sdp += `a=fingerprint:${fingerprint.algorithm.toUpperCase()} ${fingerprint.value}\r\n`;
  }
  sdp += `a=setup:${setup}\r\n`;
  
  // SCTP
  sdp += 'a=mid:0\r\n';
  sdp += 'a=sctp-port:5000\r\n';
  sdp += 'a=max-message-size:262144\r\n';
  
  // ICE candidates
  for (const candidate of candidates) {
    if (candidate.candidate) {
      sdp += `a=${candidate.candidate}\r\n`;
    }
  }
  
  return sdp;
}

/**
 * Generate a simple SDP answer for data channel only
 * @param {Object} options - Generation options
 * @param {string} options.iceUfrag - ICE username fragment
 * @param {string} options.icePwd - ICE password
 * @param {Array<Object>} options.fingerprints - DTLS fingerprints
 * @param {Array<Object>} options.candidates - ICE candidates
 * @param {string} [options.setup='active'] - DTLS setup role
 * @returns {string} SDP answer
 */
function generateAnswer(options) {
  // Answer is similar to offer but with different setup role
  return generateOffer({
    ...options,
    setup: options.setup || 'active'
  });
}

/**
 * Parse SDP string to extract ICE candidates
 * @param {string} sdp - SDP string
 * @returns {Array<Object>} Array of candidate objects
 */
function parseCandidates(sdp) {
  const candidates = [];
  const lines = sdp.split('\r\n');
  
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) {
      candidates.push({
        candidate: line.substring(2),
        sdpMid: '0',
        sdpMLineIndex: 0
      });
    }
  }
  
  return candidates;
}

/**
 * Parse SDP to extract ICE parameters
 * @param {string} sdp - SDP string
 * @returns {Object} ICE parameters
 */
function parseIceParameters(sdp) {
  const lines = sdp.split('\r\n');
  const params = {
    usernameFragment: null,
    password: null
  };
  
  for (const line of lines) {
    if (line.startsWith('a=ice-ufrag:')) {
      params.usernameFragment = line.substring(12);
    } else if (line.startsWith('a=ice-pwd:')) {
      params.password = line.substring(10);
    }
  }
  
  return params;
}

/**
 * Parse SDP to extract DTLS parameters
 * @param {string} sdp - SDP string
 * @returns {Object} DTLS parameters
 */
function parseDtlsParameters(sdp) {
  const lines = sdp.split('\r\n');
  const params = {
    role: 'auto',
    fingerprints: []
  };
  
  for (const line of lines) {
    if (line.startsWith('a=setup:')) {
      const setup = line.substring(8);
      if (setup === 'active') params.role = 'client';
      else if (setup === 'passive') params.role = 'server';
      else params.role = 'auto';
    } else if (line.startsWith('a=fingerprint:')) {
      const parts = line.substring(14).split(' ');
      if (parts.length === 2) {
        params.fingerprints.push({
          algorithm: parts[0].toLowerCase(),
          value: parts[1]
        });
      }
    }
  }
  
  return params;
}

/**
 * Parse SDP to extract SCTP parameters
 * @param {string} sdp - SDP string
 * @returns {Object} SCTP parameters
 */
function parseSctpParameters(sdp) {
  const lines = sdp.split('\r\n');
  const params = {
    port: 5000,
    maxMessageSize: 262144
  };
  
  for (const line of lines) {
    if (line.startsWith('a=sctp-port:')) {
      params.port = parseInt(line.substring(12), 10);
    } else if (line.startsWith('a=max-message-size:')) {
      params.maxMessageSize = parseInt(line.substring(19), 10);
    }
  }
  
  return params;
}

/**
 * Generate random ICE credentials
 * @returns {Object} ICE credentials
 */
function generateIceCredentials() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const randomString = (length) => {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };
  
  return {
    usernameFragment: randomString(4),
    password: randomString(24)
  };
}

module.exports = {
  generateOffer,
  generateAnswer,
  parseCandidates,
  parseIceParameters,
  parseDtlsParameters,
  parseSctpParameters,
  generateIceCredentials
};
