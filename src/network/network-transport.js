/**
 * @file network-transport.js
 * @description Real UDP/TCP network transport implementation
 * @module network/network-transport
 * 
 * Provides real networking capabilities using Node.js net and dgram packages
 */

'use strict';

const dgram = require('dgram');
const net = require('net');
const EventEmitter = require('events');
const crypto = require('crypto');

/**
 * Transport protocol types
 */
const TransportProtocol = Object.freeze({
  UDP: 'udp',
  TCP: 'tcp'
});

/**
 * @class NetworkTransport
 * @extends EventEmitter
 * @description Base class for network transport
 * 
 * Events:
 * - 'data': (data, rinfo) - Data received
 * - 'error': (error) - Error occurred
 * - 'listening': () - Socket is listening
 * - 'close': () - Socket closed
 */
class NetworkTransport extends EventEmitter {
  constructor(protocol = TransportProtocol.UDP) {
    super();
    this.protocol = protocol;
    this.socket = null;
    this.localAddress = null;
    this.localPort = null;
    this.isListening = false;
  }

  /**
   * Bind to a local address and port
   * @param {number} [port=0] - Port to bind (0 for random)
   * @param {string} [address='0.0.0.0'] - Address to bind
   * @returns {Promise<{address: string, port: number}>}
   */
  async bind(port = 0, address = '0.0.0.0') {
    throw new Error('Must be implemented by subclass');
  }

  /**
   * Send data to remote address
   * @param {Buffer} data - Data to send
   * @param {string} address - Remote address
   * @param {number} port - Remote port
   * @returns {Promise<void>}
   */
  async send(data, address, port) {
    throw new Error('Must be implemented by subclass');
  }

  /**
   * Close the transport
   */
  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.isListening = false;
  }
}

/**
 * @class UDPTransport
 * @extends NetworkTransport
 * @description UDP transport implementation using dgram
 */
class UDPTransport extends NetworkTransport {
  constructor() {
    super(TransportProtocol.UDP);
  }

  /**
   * Bind to a local address and port
   * @param {number} [port=0] - Port to bind (0 for random)
   * @param {string} [address='0.0.0.0'] - Address to bind
   * @returns {Promise<{address: string, port: number}>}
   */
  async bind(port = 0, address = '0.0.0.0') {
    if (this.socket) {
      throw new Error('Already bound');
    }

    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('message', (msg, rinfo) => {
        this.emit('data', msg, rinfo);
      });

      this.socket.on('error', (error) => {
        this.emit('error', error);
      });

      this.socket.on('close', () => {
        this.isListening = false;
        this.emit('close');
      });

      this.socket.bind(port, address, () => {
        const addr = this.socket.address();
        this.localAddress = addr.address;
        this.localPort = addr.port;
        this.isListening = true;
        this.emit('listening');
        resolve({ address: addr.address, port: addr.port });
      });
    });
  }

  /**
   * Send data to remote address
   * @param {Buffer} data - Data to send
   * @param {string} address - Remote address
   * @param {number} port - Remote port
   * @returns {Promise<void>}
   */
  async send(data, address, port) {
    if (!this.socket) {
      throw new Error('Socket not bound');
    }

    return new Promise((resolve, reject) => {
      this.socket.send(data, port, address, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}

/**
 * @class TCPTransport
 * @extends NetworkTransport
 * @description TCP transport implementation using net
 * Supports both server (listening) and client (connecting) modes
 */
class TCPTransport extends NetworkTransport {
  constructor() {
    super(TransportProtocol.TCP);
    this.server = null;
    this.connections = new Map(); // connection id -> socket
    this.mode = null; // 'server' or 'client'
  }

  /**
   * Start listening for connections (server mode)
   * @param {number} [port=0] - Port to listen on (0 for random)
   * @param {string} [address='0.0.0.0'] - Address to bind
   * @returns {Promise<{address: string, port: number}>}
   */
  async listen(port = 0, address = '0.0.0.0') {
    if (this.server) {
      throw new Error('Already listening');
    }

    this.mode = 'server';

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this._handleConnection(socket);
      });

      this.server.on('error', (error) => {
        this.emit('error', error);
      });

      this.server.on('close', () => {
        this.isListening = false;
        this.emit('close');
      });

      this.server.listen(port, address, () => {
        const addr = this.server.address();
        this.localAddress = addr.address;
        this.localPort = addr.port;
        this.isListening = true;
        this.emit('listening');
        resolve({ address: addr.address, port: addr.port });
      });
    });
  }

  /**
   * Connect to remote server (client mode)
   * @param {string} address - Remote address
   * @param {number} port - Remote port
   * @returns {Promise<void>}
   */
  async connect(address, port) {
    if (this.mode === 'server') {
      throw new Error('Cannot connect in server mode');
    }

    this.mode = 'client';

    return new Promise((resolve, reject) => {
      const socket = net.connect(port, address, () => {
        this._handleConnection(socket);
        resolve();
      });

      socket.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Handle new connection
   * @param {net.Socket} socket - TCP socket
   * @private
   */
  _handleConnection(socket) {
    const connectionId = crypto.randomBytes(8).toString('hex');
    this.connections.set(connectionId, socket);

    const rinfo = {
      address: socket.remoteAddress,
      port: socket.remotePort,
      connectionId
    };

    // Handle incoming data
    socket.on('data', (data) => {
      this.emit('data', data, rinfo);
    });

    // Handle socket close
    socket.on('close', () => {
      this.connections.delete(connectionId);
      this.emit('connectionClosed', connectionId);
    });

    // Handle errors
    socket.on('error', (error) => {
      this.emit('error', error);
    });

    // Emit connection event
    this.emit('connection', connectionId, rinfo);
  }

  /**
   * Send data to specific connection or address
   * @param {Buffer} data - Data to send
   * @param {string} addressOrConnectionId - Remote address or connection ID
   * @param {number} [port] - Remote port (not needed if using connection ID)
   * @returns {Promise<void>}
   */
  async send(data, addressOrConnectionId, port) {
    // If in server mode or already have connection, use connection ID
    if (this.connections.has(addressOrConnectionId)) {
      const socket = this.connections.get(addressOrConnectionId);
      return new Promise((resolve, reject) => {
        socket.write(data, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    // Otherwise, send to all connections (broadcast)
    if (this.connections.size > 0) {
      const promises = [];
      for (const socket of this.connections.values()) {
        promises.push(
          new Promise((resolve, reject) => {
            socket.write(data, (error) => {
              if (error) reject(error);
              else resolve();
            });
          })
        );
      }
      await Promise.all(promises);
    } else {
      throw new Error('No active connections');
    }
  }

  /**
   * Close specific connection or all connections
   * @param {string} [connectionId] - Connection ID to close (omit to close all)
   */
  closeConnection(connectionId) {
    if (connectionId) {
      const socket = this.connections.get(connectionId);
      if (socket) {
        socket.end();
        this.connections.delete(connectionId);
      }
    } else {
      // Close all connections
      for (const socket of this.connections.values()) {
        socket.end();
      }
      this.connections.clear();
    }
  }

  /**
   * Close the transport and all connections
   */
  close() {
    // Close all connections
    this.closeConnection();

    // Close server
    if (this.server) {
      this.server.close();
      this.server = null;
    }

    this.isListening = false;
    this.mode = null;
  }

  /**
   * Bind is an alias for listen in TCP
   */
  async bind(port, address) {
    return this.listen(port, address);
  }
}

/**
 * @class DataChannelTransport
 * @description High-level transport for data channels using TCP
 * Implements message framing with length prefix
 */
class DataChannelTransport extends EventEmitter {
  constructor() {
    super();
    this.tcpTransport = new TCPTransport();
    this.messageBuffers = new Map(); // connection -> incomplete message buffer

    // Forward events
    this.tcpTransport.on('connection', (connectionId, rinfo) => {
      this.messageBuffers.set(connectionId, Buffer.alloc(0));
      this.emit('connection', connectionId, rinfo);
    });

    this.tcpTransport.on('connectionClosed', (connectionId) => {
      this.messageBuffers.delete(connectionId);
      this.emit('connectionClosed', connectionId);
    });

    this.tcpTransport.on('data', (data, rinfo) => {
      this._handleData(data, rinfo);
    });

    this.tcpTransport.on('error', (error) => {
      this.emit('error', error);
    });

    this.tcpTransport.on('listening', () => {
      this.emit('listening');
    });

    this.tcpTransport.on('close', () => {
      this.emit('close');
    });
  }

  /**
   * Handle incoming data with message framing
   * Message format: [4 bytes length][message data]
   * @private
   */
  _handleData(data, rinfo) {
    const connectionId = rinfo.connectionId || 'default';
    
    // Get existing buffer or create new
    let buffer = this.messageBuffers.get(connectionId) || Buffer.alloc(0);
    buffer = Buffer.concat([buffer, data]);
    this.messageBuffers.set(connectionId, buffer);

    // Process complete messages
    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32BE(0);
      
      if (buffer.length >= 4 + messageLength) {
        // Extract complete message
        const message = buffer.slice(4, 4 + messageLength);
        buffer = buffer.slice(4 + messageLength);
        this.messageBuffers.set(connectionId, buffer);

        // Emit message event
        this.emit('message', message, rinfo);
      } else {
        // Incomplete message, wait for more data
        break;
      }
    }
  }

  /**
   * Send message with length prefix
   * @param {Buffer|string} message - Message to send
   * @param {string} [connectionId] - Connection ID (for server mode)
   * @returns {Promise<void>}
   */
  async sendMessage(message, connectionId) {
    const messageBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
    
    // Create framed message: [length][data]
    const frame = Buffer.alloc(4 + messageBuffer.length);
    frame.writeUInt32BE(messageBuffer.length, 0);
    messageBuffer.copy(frame, 4);

    if (connectionId) {
      await this.tcpTransport.send(frame, connectionId);
    } else {
      // Broadcast to all connections
      await this.tcpTransport.send(frame);
    }
  }

  /**
   * Start listening (server mode)
   */
  async listen(port, address) {
    return this.tcpTransport.listen(port, address);
  }

  /**
   * Connect to remote (client mode)
   */
  async connect(address, port) {
    return this.tcpTransport.connect(address, port);
  }

  /**
   * Get local address info
   */
  get localAddress() {
    return this.tcpTransport.localAddress;
  }

  get localPort() {
    return this.tcpTransport.localPort;
  }

  /**
   * Close transport
   */
  close() {
    this.messageBuffers.clear();
    this.tcpTransport.close();
  }
}

module.exports = {
  NetworkTransport,
  UDPTransport,
  TCPTransport,
  DataChannelTransport,
  TransportProtocol
};
