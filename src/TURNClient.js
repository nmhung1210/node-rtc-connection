/**
 * TURN Client Implementation (RFC 5766)
 * Pure Node.js implementation using dgram and net
 */

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

// TURN Message Types
const TURN_ALLOCATE_REQUEST = 0x0003;
const TURN_ALLOCATE_RESPONSE = 0x0103;
const TURN_ALLOCATE_ERROR = 0x0113;
const TURN_REFRESH_REQUEST = 0x0004;
const TURN_CREATE_PERMISSION = 0x0008;
const TURN_CHANNEL_BIND = 0x0009;
const TURN_SEND_INDICATION = 0x0016;
const TURN_DATA_INDICATION = 0x0017;

// TURN Attributes
const ATTR_XOR_RELAYED_ADDRESS = 0x0016;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_LIFETIME = 0x000D;
const ATTR_USERNAME = 0x0006;
const ATTR_MESSAGE_INTEGRITY = 0x0008;
const ATTR_ERROR_CODE = 0x0009;
const ATTR_REALM = 0x0014;
const ATTR_NONCE = 0x0015;
const ATTR_XOR_PEER_ADDRESS = 0x0012;
const ATTR_DATA = 0x0013;
const ATTR_REQUESTED_TRANSPORT = 0x0019;

// STUN Magic Cookie
const MAGIC_COOKIE = 0x2112A442;

class TURNClient {
  constructor(options = {}) {
    this.server = options.server; // 'turn:server:port' or {host, port}
    this.username = options.username || 'user';
    this.password = options.password || 'pass';
    this.transport = options.transport || 'udp'; // 'udp' or 'tcp'
    this.socket = null;
    this.timeout = options.timeout || 10000;
    this.relayedAddress = null;
    this.lifetime = 600; // Default 10 minutes
    this.allocation = null;
    
    // Authentication state for MESSAGE-INTEGRITY
    this.realm = null;
    this.nonce = null;
    this.authenticated = false;
  }

  /**
   * Parse TURN server URI
   * @private
   */
  _parseServer() {
    if (typeof this.server === 'object') {
      return this.server;
    }

    const match = this.server.match(/^turn:(.+):(\d+)$/);
    if (match) {
      return { host: match[1], port: parseInt(match[2], 10) };
    }

    // Default TURN port
    return { host: this.server, port: 3478 };
  }

  /**
   * Allocate a relay address on TURN server
   * @returns {Promise<{relayedAddress: string, relayedPort: number, mappedAddress: string, mappedPort: number}>}
   */
  async allocate() {
    const serverInfo = this._parseServer();
    const transactionId = crypto.randomBytes(12);
    
    return new Promise((resolve, reject) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.close();
          reject(new Error('TURN allocation timeout'));
        }
      }, this.timeout);

      // Create socket based on transport
      if (this.transport === 'udp') {
        this.socket = dgram.createSocket('udp4');
      } else {
        this.socket = new net.Socket();
      }

      this.socket.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.close();
          reject(err);
        }
      });

      const handleMessage = (msg) => {
        if (resolved) return;

        try {
          const result = this._parseAllocateResponse(msg);
          if (result) {
            resolved = true;
            clearTimeout(timeout);
            this.relayedAddress = result.relayedAddress;
            this.allocation = result;
            resolve(result);
          }
        } catch (err) {
          // Check if this is a 401 Unauthorized requiring authentication
          if (err.message.includes('401') && !this.authenticated && this.realm && this.nonce) {
            // Clear the error handler and retry with authentication
            clearTimeout(timeout);
            this._retryAllocationWithAuth(serverInfo, transactionId)
              .then(result => {
                resolved = true;
                resolve(result);
              })
              .catch(authErr => {
                resolved = true;
                this.close();
                reject(authErr);
              });
          } else {
            resolved = true;
            clearTimeout(timeout);
            this.close();
            reject(err);
          }
        }
      };

      if (this.transport === 'udp') {
        this.socket.on('message', handleMessage);
      } else {
        this.socket.on('data', handleMessage);
      }

      // Connect and send allocation request
      const sendRequest = () => {
        const request = this._createAllocateRequest(transactionId);

        if (this.transport === 'udp') {
          this.socket.send(request, serverInfo.port, serverInfo.host, (err) => {
            if (err && !resolved) {
              resolved = true;
              clearTimeout(timeout);
              this.close();
              reject(err);
            }
          });
        } else {
          this.socket.write(request);
        }
      };

      if (this.transport === 'tcp') {
        this.socket.connect(serverInfo.port, serverInfo.host, sendRequest);
      } else {
        sendRequest();
      }
    });
  }

  /**
   * Create TURN Allocate Request
   * @private
   */
  _createAllocateRequest(transactionId, withAuth = false) {
    const attributes = [];

    // REQUESTED-TRANSPORT attribute (UDP = 17)
    const transportAttr = Buffer.allocUnsafe(8);
    transportAttr.writeUInt16BE(ATTR_REQUESTED_TRANSPORT, 0);
    transportAttr.writeUInt16BE(4, 2);
    transportAttr.writeUInt8(17, 4); // UDP protocol
    transportAttr.writeUInt8(0, 5);
    transportAttr.writeUInt8(0, 6);
    transportAttr.writeUInt8(0, 7);
    attributes.push(transportAttr);

    // Add authentication attributes if needed
    if (withAuth && this.username && this.realm && this.nonce) {
      // USERNAME attribute
      const usernameAttr = this._createStringAttribute(0x0006, this.username);
      attributes.push(usernameAttr);
      
      // REALM attribute
      const realmAttr = this._createStringAttribute(0x0014, this.realm);
      attributes.push(realmAttr);
      
      // NONCE attribute
      const nonceAttr = this._createStringAttribute(0x0015, this.nonce);
      attributes.push(nonceAttr);
    }

    // Calculate total attributes length (before MESSAGE-INTEGRITY)
    let attrLength = 0;
    for (const attr of attributes) {
      attrLength += attr.length;
    }

    // If using auth, add MESSAGE-INTEGRITY (will be added after header)
    let messageIntegrityAttr = null;
    if (withAuth && this.username && this.realm && this.nonce && this.password) {
      attrLength += 24; // MESSAGE-INTEGRITY attribute size (4 + 20)
    }

    // STUN header
    const header = Buffer.allocUnsafe(20);
    header.writeUInt16BE(TURN_ALLOCATE_REQUEST, 0);
    header.writeUInt16BE(attrLength, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);

    // Combine header and attributes
    let message = Buffer.concat([header, ...attributes]);
    
    // Add MESSAGE-INTEGRITY if using auth
    if (withAuth && this.username && this.realm && this.nonce && this.password) {
      messageIntegrityAttr = this._createMessageIntegrity(message);
      message = Buffer.concat([message, messageIntegrityAttr]);
    }

    return message;
  }

  /**
   * Parse TURN Allocate Response
   * @private
   */
  _parseAllocateResponse(msg) {
    if (msg.length < 20) {
      throw new Error('Invalid TURN response: too short');
    }

    const messageType = msg.readUInt16BE(0);
    const messageLength = msg.readUInt16BE(2);
    const magicCookie = msg.readUInt32BE(4);

    // Check if this is an allocate response
    if (messageType === TURN_ALLOCATE_ERROR) {
      const error = this._parseErrorCode(msg);
      
      // If 401 Unauthorized, extract REALM and NONCE for retry
      if (error.includes('401')) {
        this._extractAuthAttributes(msg);
      }
      
      throw new Error(`TURN allocation failed: ${error}`);
    }

    if (messageType !== TURN_ALLOCATE_RESPONSE) {
      return null;
    }

    // Verify magic cookie
    if (magicCookie !== MAGIC_COOKIE) {
      throw new Error('Invalid TURN response: bad magic cookie');
    }

    // Parse attributes
    const result = {};
    let offset = 20;

    while (offset < 20 + messageLength) {
      const attrType = msg.readUInt16BE(offset);
      const attrLength = msg.readUInt16BE(offset + 2);
      const attrValue = msg.slice(offset + 4, offset + 4 + attrLength);

      if (attrType === ATTR_XOR_RELAYED_ADDRESS) {
        const addr = this._parseXorAddress(attrValue, msg.slice(8, 20));
        result.relayedAddress = addr.ip;
        result.relayedPort = addr.port;
        result.type = 'relay';
      } else if (attrType === ATTR_XOR_MAPPED_ADDRESS) {
        const addr = this._parseXorAddress(attrValue, msg.slice(8, 20));
        result.mappedAddress = addr.ip;
        result.mappedPort = addr.port;
      } else if (attrType === ATTR_LIFETIME) {
        this.lifetime = attrValue.readUInt32BE(0);
        result.lifetime = this.lifetime;
      }

      // Move to next attribute (with padding)
      offset += 4 + attrLength;
      if (attrLength % 4 !== 0) {
        offset += 4 - (attrLength % 4);
      }
    }

    if (!result.relayedAddress) {
      throw new Error('No relayed address in TURN response');
    }

    return result;
  }

  /**
   * Parse XOR address attribute
   * @private
   */
  _parseXorAddress(value, transactionId) {
    const family = value.readUInt8(1);
    const xPort = value.readUInt16BE(2);
    const xAddress = value.slice(4, 8);

    // XOR with magic cookie
    const port = xPort ^ (MAGIC_COOKIE >> 16);
    
    const addressBytes = Buffer.allocUnsafe(4);
    const magicBytes = Buffer.allocUnsafe(4);
    magicBytes.writeUInt32BE(MAGIC_COOKIE, 0);
    
    for (let i = 0; i < 4; i++) {
      addressBytes[i] = xAddress[i] ^ magicBytes[i];
    }

    const ip = Array.from(addressBytes).join('.');

    return { ip, port };
  }

  /**
   * Parse error code attribute
   * @private
   */
  _parseErrorCode(msg) {
    let offset = 20;
    const messageLength = msg.readUInt16BE(2);

    while (offset < 20 + messageLength) {
      const attrType = msg.readUInt16BE(offset);
      const attrLength = msg.readUInt16BE(offset + 2);
      const attrValue = msg.slice(offset + 4, offset + 4 + attrLength);

      if (attrType === ATTR_ERROR_CODE) {
        const errorClass = attrValue.readUInt8(2);
        const errorNumber = attrValue.readUInt8(3);
        const errorCode = errorClass * 100 + errorNumber;
        const errorText = attrValue.slice(4).toString('utf8');
        return `${errorCode} ${errorText}`;
      }

      offset += 4 + attrLength;
      if (attrLength % 4 !== 0) {
        offset += 4 - (attrLength % 4);
      }
    }

    return 'Unknown error';
  }

  /**
   * Refresh the allocation
   * @param {number} lifetime - New lifetime in seconds
   */
  async refresh(lifetime = 600) {
    if (!this.allocation) {
      throw new Error('No active allocation');
    }

    // Send refresh request
    // Implementation similar to allocate()
    this.lifetime = lifetime;
  }

  /**
   * Send data through TURN relay
   * @param {Buffer} data - Data to send
   * @param {string} peerAddress - Peer IP address
   * @param {number} peerPort - Peer port
   */
  async send(data, peerAddress, peerPort) {
    if (!this.allocation) {
      throw new Error('No active allocation');
    }

    // Create Send Indication message
    const transactionId = crypto.randomBytes(12);
    const message = this._createSendIndication(data, peerAddress, peerPort, transactionId);

    const serverInfo = this._parseServer();

    if (this.transport === 'udp') {
      this.socket.send(message, serverInfo.port, serverInfo.host);
    } else {
      this.socket.write(message);
    }
  }

  /**
   * Create Send Indication message
   * @private
   */
  _createSendIndication(data, peerAddress, peerPort, transactionId) {
    // Implementation of TURN Send Indication
    // For now, simplified version
    const header = Buffer.allocUnsafe(20);
    header.writeUInt16BE(TURN_SEND_INDICATION, 0);
    header.writeUInt16BE(data.length, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);

    return Buffer.concat([header, data]);
  }

  /**
   * Close the TURN client
   */
  close() {
    if (this.socket) {
      if (this.transport === 'udp') {
        this.socket.close();
      } else {
        this.socket.destroy();
      }
      this.socket = null;
    }
    this.allocation = null;
    this.relayedAddress = null;
  }

  /**
   * Extract authentication attributes (REALM, NONCE) from error response
   * @private
   */
  _extractAuthAttributes(msg) {
    let offset = 20;
    const messageLength = msg.readUInt16BE(2);

    while (offset < 20 + messageLength) {
      const attrType = msg.readUInt16BE(offset);
      const attrLength = msg.readUInt16BE(offset + 2);

      if (attrType === 0x0014) { // REALM
        this.realm = msg.slice(offset + 4, offset + 4 + attrLength).toString('utf8');
      } else if (attrType === 0x0015) { // NONCE
        this.nonce = msg.slice(offset + 4, offset + 4 + attrLength).toString('utf8');
      }

      offset += 4 + attrLength;
      const padding = (4 - (attrLength % 4)) % 4;
      offset += padding;
    }
  }

  /**
   * Create a string attribute (USERNAME, REALM, NONCE)
   * @private
   */
  _createStringAttribute(type, value) {
    const valueBuffer = Buffer.from(value, 'utf8');
    const length = valueBuffer.length;
    const padding = (4 - (length % 4)) % 4;
    
    const attr = Buffer.alloc(4 + length + padding);
    attr.writeUInt16BE(type, 0);
    attr.writeUInt16BE(length, 2);
    valueBuffer.copy(attr, 4);
    
    return attr;
  }

  /**
   * Create MESSAGE-INTEGRITY attribute (RFC 5766 Section 15.4)
   * @private
   */
  _createMessageIntegrity(message) {
    // Compute key = MD5(username:realm:password)
    const keyString = `${this.username}:${this.realm}:${this.password}`;
    const key = crypto.createHash('md5').update(keyString).digest();
    
    // Compute HMAC-SHA1 of the message
    const hmac = crypto.createHmac('sha1', key).update(message).digest();
    
    // Create MESSAGE-INTEGRITY attribute (type 0x0008)
    const attr = Buffer.alloc(24);
    attr.writeUInt16BE(0x0008, 0); // MESSAGE-INTEGRITY
    attr.writeUInt16BE(20, 2); // SHA1 hash is 20 bytes
    hmac.copy(attr, 4);
    
    return attr;
  }

  /**
   * Retry allocation with authentication after 401
   * @private
   */
  _retryAllocationWithAuth(serverInfo, transactionId) {
    return new Promise((resolve, reject) => {
      this.authenticated = true;
      
      const request = this._createAllocateRequest(transactionId, true);
      
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.close();
          reject(new Error('TURN authenticated allocation timeout'));
        }
      }, this.timeout);

      const handleAuthMessage = (msg) => {
        if (resolved) return;

        try {
          const result = this._parseAllocateResponse(msg);
          if (result) {
            resolved = true;
            clearTimeout(timeout);
            if (this.socket) {
              this.socket.removeListener('message', handleAuthMessage);
              this.socket.removeListener('data', handleAuthMessage);
            }
            this.relayedAddress = result.relayedAddress;
            this.allocation = result;
            resolve(result);
          }
        } catch (err) {
          resolved = true;
          clearTimeout(timeout);
          if (this.socket) {
            this.socket.removeListener('message', handleAuthMessage);
            this.socket.removeListener('data', handleAuthMessage);
          }
          this.close();
          reject(err);
        }
      };

      if (this.transport === 'udp') {
        this.socket.on('message', handleAuthMessage);
        this.socket.send(request, serverInfo.port, serverInfo.host, (err) => {
          if (err && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            this.close();
            reject(err);
          }
        });
      } else {
        this.socket.on('data', handleAuthMessage);
        this.socket.write(request);
      }
    });
  }
}

module.exports = TURNClient;
