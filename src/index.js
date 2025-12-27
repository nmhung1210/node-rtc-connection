/**
 * NodeRTC - DataChannel-only WebRTC implementation for Node.js
 * Ported from Chromium's PeerConnection implementation
 * 
 * This is a simplified implementation focusing on DataChannel functionality.
 * It does not include media stream support (audio/video).
 */

const RTCPeerConnection = require('./RTCPeerConnection');
const RTCDataChannel = require('./RTCDataChannel');
const RTCSessionDescription = require('./RTCSessionDescription');
const RTCIceCandidate = require('./RTCIceCandidate');
const RTCDataChannelEvent = require('./RTCDataChannelEvent');
const RTCPeerConnectionIceEvent = require('./RTCPeerConnectionIceEvent');
const { RTCError, RTCErrorEvent } = require('./RTCError');
const NativePeerConnectionFactory = require('./NativePeerConnectionFactory');

// Create a singleton factory instance
const defaultFactory = new NativePeerConnectionFactory();

/**
 * Create a new RTCPeerConnection with the default factory
 * @param {Object} configuration - RTCConfiguration
 * @returns {RTCPeerConnection}
 */
function createPeerConnection(configuration) {
  return new RTCPeerConnection(configuration, defaultFactory);
}

/**
 * Create a custom RTCPeerConnection with a specific factory
 * @param {Object} configuration - RTCConfiguration
 * @param {NativePeerConnectionFactory} factory - Custom factory
 * @returns {RTCPeerConnection}
 */
function createPeerConnectionWithFactory(configuration, factory) {
  return new RTCPeerConnection(configuration, factory);
}

module.exports = {
  // Main API
  RTCPeerConnection,
  createPeerConnection,
  createPeerConnectionWithFactory,
  
  // Classes
  RTCDataChannel,
  RTCSessionDescription,
  RTCIceCandidate,
  RTCDataChannelEvent,
  RTCPeerConnectionIceEvent,
  RTCError,
  RTCErrorEvent,
  
  // Factory
  NativePeerConnectionFactory,
  defaultFactory
};
