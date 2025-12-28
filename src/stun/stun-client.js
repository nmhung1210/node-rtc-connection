/**
 * @file stun-client.js
 * @description STUN (Session Traversal Utilities for NAT) client implementation
 * @module stun/stun-client
 * 
 * STUN Protocol: RFC 5389
 * TURN Protocol: RFC 5766
 */

'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const EventEmitter = require('events');

/**
 * STUN message types
 */
const STUN_MESSAGE_TYPES = {
  BINDING_REQUEST: 0x0001,
  BINDING_RESPONSE: 0x0101,
  BINDING_ERROR_RESPONSE: 0x0111,
  
  // TURN
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_RESPONSE: 0x0103,
  ALLOCATE_ERROR_RESPONSE: 0x0113,
  
  REFRESH_REQUEST: 0x0004,
  REFRESH_RESPONSE: 0x0104,
  
  SEND_INDICATION: 0x0016,
  DATA_INDICATION: 0x0017,
  
  CREATE_PERMISSION_REQUEST: 0x0008,
  CREATE_PERMISSION_RESPONSE: 0x0108,
  
  CHANNEL_BIND_REQUEST: 0x0009,
  CHANNEL_BIND_RESPONSE: 0x0109
};

/**
 * STUN attribute types
 */
const STUN_ATTRIBUTES = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000A,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_MAPPED_ADDRESS: 0x0020,
  
  // TURN
  CHANNEL_NUMBER: 0x000C,
  LIFETIME: 0x000D,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028
};

const MAGIC_COOKIE = 0x2112A442;

/**
 * @class STUNClient
 * @description STUN/TURN client for NAT traversal
 */
class STUNClient extends EventEmitter {
  /**
   * Create a STUN client
   * @param {Object} options - Client options
   * @param {string} options.server - STUN/TURN server address
   * @param {number} options.port - Server port
   * @param {string} [options.username] - TURN username
   * @param {string} [options.credential] - TURN password
   * @param {string} [options.transport='udp'] - Transport protocol (udp/tcp)
   * @param {Object} [options.params={}] - Additional query parameters from URL
   */
  constructor(options) {
    super();
    this.server = options.server;
    this.port = options.port;
    this.username = options.username;
    this.credential = options.credential;
    this.transport = options.transport || 'udp';
    this.params = options.params || {};
    
    this.socket = null;
    this.transactions = new Map();
    this.realm = null;
    this.nonce = null;
  }

  /**
   * Connect to the STUN/TURN server
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.socket) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      
      this.socket.on('message', (msg, rinfo) => {
        this._handleMessage(msg, rinfo);
      });

      this.socket.on('error', (err) => {
        console.error('STUN socket error:', err);
        reject(err);
      });

      this.socket.bind(() => {
        resolve();
      });
    });
  }

  /**
   * Send a STUN Binding Request to get reflexive address
   * @returns {Promise<Object>} Reflexive address info
   */
  async getReflexiveAddress() {
    await this.connect();

    const transactionId = crypto.randomBytes(12);
    const request = this._createBindingRequest(transactionId);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transactions.delete(transactionId.toString('hex'));
        reject(new Error('STUN request timeout'));
      }, 5000);

      this.transactions.set(transactionId.toString('hex'), {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.socket.send(request, this.port, this.server, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.transactions.delete(transactionId.toString('hex'));
          reject(err);
        }
      });
    });
  }

  /**
   * Send a TURN Allocate Request to get relay address
   * @param {number} [lifetime=600] - Allocation lifetime in seconds
   * @returns {Promise<Object>} Relay address info
   */
  async allocateRelay(lifetime = 600) {
    if (!this.username || !this.credential) {
      throw new Error('TURN requires username and credential');
    }

    await this.connect();

    let transactionId = crypto.randomBytes(12);
    let request = this._createAllocateRequest(transactionId, lifetime);

    // First attempt without credentials to get realm and nonce
    try {
      return await this._sendRequest(request, transactionId, 'allocate');
    } catch (error) {
      // If we get 401 Unauthorized, retry with credentials
      if (error.message.includes('401') && this.realm && this.nonce) {
        // Create new transaction ID for retry
        transactionId = crypto.randomBytes(12);
        request = this._createAllocateRequest(transactionId, lifetime, true);
        return await this._sendRequest(request, transactionId, 'allocate');
      }
      throw error;
    }
  }

  /**
   * Send a TURN Refresh Request to keep allocation alive
   * @param {number} [lifetime=600] - Allocation lifetime in seconds
   * @returns {Promise<Object>} Updated allocation info
   */
  async refreshAllocation(lifetime = 600) {
    if (!this.username || !this.credential) {
      throw new Error('TURN requires username and credential');
    }

    const transactionId = crypto.randomBytes(12);
    const request = this._createRefreshRequest(transactionId, lifetime);

    return this._sendRequest(request, transactionId, 'refresh');
  }

  /**
   * Create a TURN Permission for a peer
   * @param {string} peerAddress - Peer IP address
   * @returns {Promise<void>}
   */
  async createPermission(peerAddress) {
    if (!this.username || !this.credential) {
      throw new Error('TURN requires username and credential');
    }

    const transactionId = crypto.randomBytes(12);
    const request = this._createCreatePermissionRequest(transactionId, peerAddress);

    await this._sendRequest(request, transactionId, 'createPermission');
  }

  /**
   * Send data to a peer via TURN Send Indication
   * @param {string} peerAddress - Peer IP address
   * @param {number} peerPort - Peer port
   * @param {Buffer} data - Data to send
   * @returns {Promise<void>}
   */
  async sendIndication(peerAddress, peerPort, data) {
    if (!this.username || !this.credential) {
      throw new Error('TURN requires username and credential');
    }

    const transactionId = crypto.randomBytes(12);
    const indication = this._createSendIndication(transactionId, peerAddress, peerPort, data);

    // Indications are fire-and-forget, no response expected
    return new Promise((resolve, reject) => {
      this.socket.send(indication, this.port, this.server, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Send a TURN request
   * @param {Buffer} request - Request message
   * @param {Buffer} transactionId - Transaction ID
   * @param {string} requestType - Type of request
   * @returns {Promise<Object>}
   * @private
   */
  _sendRequest(request, transactionId, requestType) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transactions.delete(transactionId.toString('hex'));
        reject(new Error(`${requestType} request timeout`));
      }, 5000);

      this.transactions.set(transactionId.toString('hex'), {
        type: requestType,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.socket.send(request, this.port, this.server, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.transactions.delete(transactionId.toString('hex'));
          reject(err);
        }
      });
    });
  }

  /**
   * Create a STUN Binding Request
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Buffer} STUN message
   * @private
   */
  _createBindingRequest(transactionId) {
    const header = Buffer.alloc(20);
    
    // Message Type (2 bytes)
    header.writeUInt16BE(STUN_MESSAGE_TYPES.BINDING_REQUEST, 0);
    
    // Message Length (2 bytes) - 0 for now, no attributes
    header.writeUInt16BE(0, 2);
    
    // Magic Cookie (4 bytes)
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    
    // Transaction ID (12 bytes)
    transactionId.copy(header, 8);
    
    return header;
  }

  /**
   * Create a TURN Allocate Request
   * @param {Buffer} transactionId - Transaction ID
   * @param {number} lifetime - Allocation lifetime in seconds
   * @param {boolean} withAuth - Include authentication
   * @returns {Buffer} STUN message
   * @private
   */
  _createAllocateRequest(transactionId, lifetime, withAuth = false) {
    const attributes = [];

    // REQUESTED-TRANSPORT (UDP = 17)
    const transport = Buffer.alloc(8);
    transport.writeUInt16BE(STUN_ATTRIBUTES.REQUESTED_TRANSPORT, 0);
    transport.writeUInt16BE(4, 2);
    transport.writeUInt8(17, 4); // UDP
    attributes.push(transport);

    // LIFETIME
    const lifetimeAttr = Buffer.alloc(8);
    lifetimeAttr.writeUInt16BE(STUN_ATTRIBUTES.LIFETIME, 0);
    lifetimeAttr.writeUInt16BE(4, 2);
    lifetimeAttr.writeUInt32BE(lifetime, 4);
    attributes.push(lifetimeAttr);

    if (withAuth && this.realm && this.nonce) {
      // USERNAME
      const usernameAttr = this._createStringAttribute(STUN_ATTRIBUTES.USERNAME, this.username);
      attributes.push(usernameAttr);

      // REALM
      const realmAttr = this._createStringAttribute(STUN_ATTRIBUTES.REALM, this.realm);
      attributes.push(realmAttr);

      // NONCE
      const nonceAttr = this._createStringAttribute(STUN_ATTRIBUTES.NONCE, this.nonce);
      attributes.push(nonceAttr);
    }

    return this._createMessage(STUN_MESSAGE_TYPES.ALLOCATE_REQUEST, transactionId, attributes, withAuth);
  }

  /**
   * Create a TURN CreatePermission Request
   * @param {Buffer} transactionId - Transaction ID
   * @param {string} peerAddress - Peer IP address
   * @returns {Buffer} STUN message
   * @private
   */
  _createCreatePermissionRequest(transactionId, peerAddress) {
    const attributes = [];

    // XOR-PEER-ADDRESS
    const peerAttr = this._createXorPeerAddressAttribute(peerAddress, 0, transactionId);
    attributes.push(peerAttr);

    // Auth attributes
    if (this.realm && this.nonce) {
      attributes.push(this._createStringAttribute(STUN_ATTRIBUTES.USERNAME, this.username));
      attributes.push(this._createStringAttribute(STUN_ATTRIBUTES.REALM, this.realm));
      attributes.push(this._createStringAttribute(STUN_ATTRIBUTES.NONCE, this.nonce));
    }

    return this._createMessage(STUN_MESSAGE_TYPES.CREATE_PERMISSION_REQUEST, transactionId, attributes, true);
  }

  /**
   * Create a TURN Send Indication
   * @param {Buffer} transactionId - Transaction ID
   * @param {string} peerAddress - Peer IP address
   * @param {number} peerPort - Peer port
   * @param {Buffer} data - Data to send
   * @returns {Buffer} STUN message
   * @private
   */
  _createSendIndication(transactionId, peerAddress, peerPort, data) {
    const attributes = [];

    // XOR-PEER-ADDRESS
    const peerAttr = this._createXorPeerAddressAttribute(peerAddress, peerPort, transactionId);
    attributes.push(peerAttr);

    // DATA
    const dataAttr = Buffer.alloc(4 + data.length + (4 - (data.length % 4)) % 4);
    dataAttr.writeUInt16BE(STUN_ATTRIBUTES.DATA, 0);
    dataAttr.writeUInt16BE(data.length, 2);
    data.copy(dataAttr, 4);
    attributes.push(dataAttr);

    return this._createMessage(STUN_MESSAGE_TYPES.SEND_INDICATION, transactionId, attributes, false);
  }

  /**
   * Create XOR-PEER-ADDRESS attribute
   * @param {string} address - IP address
   * @param {number} port - Port
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Buffer} Attribute buffer
   * @private
   */
  _createXorPeerAddressAttribute(address, port, transactionId) {
    const family = 0x01; // IPv4
    const buffer = Buffer.alloc(4 + 8); // Type(2) + Length(2) + Reserved(1) + Family(1) + Port(2) + Address(4)
    
    buffer.writeUInt16BE(STUN_ATTRIBUTES.XOR_PEER_ADDRESS, 0);
    buffer.writeUInt16BE(8, 2);
    buffer.writeUInt8(0, 4);
    buffer.writeUInt8(family, 5);

    // XOR Port
    const xorPort = port ^ (MAGIC_COOKIE >> 16);
    buffer.writeUInt16BE(xorPort, 6);

    // XOR Address
    const parts = address.split('.').map(Number);
    const addrInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
    const xorAddr = addrInt ^ MAGIC_COOKIE;
    
    buffer.writeUInt32BE(xorAddr >>> 0, 8); // Ensure unsigned

    return buffer;
  }

  /**
   * Create a TURN Refresh Request
   * @param {Buffer} transactionId - Transaction ID
   * @param {number} lifetime - Allocation lifetime in seconds
   * @returns {Buffer} STUN message
   * @private
   */
  _createRefreshRequest(transactionId, lifetime) {
    const attributes = [];

    // LIFETIME
    const lifetimeAttr = Buffer.alloc(8);
    lifetimeAttr.writeUInt16BE(STUN_ATTRIBUTES.LIFETIME, 0);
    lifetimeAttr.writeUInt16BE(4, 2);
    lifetimeAttr.writeUInt32BE(lifetime, 4);
    attributes.push(lifetimeAttr);

    // USERNAME
    const usernameAttr = this._createStringAttribute(STUN_ATTRIBUTES.USERNAME, this.username);
    attributes.push(usernameAttr);

    // REALM
    if (this.realm) {
      const realmAttr = this._createStringAttribute(STUN_ATTRIBUTES.REALM, this.realm);
      attributes.push(realmAttr);
    }

    // NONCE
    if (this.nonce) {
      const nonceAttr = this._createStringAttribute(STUN_ATTRIBUTES.NONCE, this.nonce);
      attributes.push(nonceAttr);
    }

    return this._createMessage(STUN_MESSAGE_TYPES.REFRESH_REQUEST, transactionId, attributes, true);
  }

  /**
   * Create a STUN message with attributes
   * @param {number} messageType - Message type
   * @param {Buffer} transactionId - Transaction ID
   * @param {Array<Buffer>} attributes - Attribute buffers
   * @param {boolean} withIntegrity - Add MESSAGE-INTEGRITY
   * @returns {Buffer} Complete STUN message
   * @private
   */
  _createMessage(messageType, transactionId, attributes, withIntegrity = false) {
    let attributesBuffer = Buffer.concat(attributes);

    // Add MESSAGE-INTEGRITY if needed
    if (withIntegrity && this.credential) {
      const tempHeader = Buffer.alloc(20);
      tempHeader.writeUInt16BE(messageType, 0);
      tempHeader.writeUInt16BE(attributesBuffer.length + 24, 2); // +24 for MESSAGE-INTEGRITY
      tempHeader.writeUInt32BE(MAGIC_COOKIE, 4);
      transactionId.copy(tempHeader, 8);

      const tempMessage = Buffer.concat([tempHeader, attributesBuffer]);
      
      // For TURN, compute key as MD5(username:realm:password) per RFC 5766
      let key = this.credential;
      if (this.username && this.realm) {
        const keyString = `${this.username}:${this.realm}:${this.credential}`;
        key = crypto.createHash('md5').update(keyString).digest();
      }
      
      const hmac = crypto.createHmac('sha1', key);
      hmac.update(tempMessage);
      const integrity = hmac.digest();

      const integrityAttr = Buffer.alloc(4 + integrity.length);
      integrityAttr.writeUInt16BE(STUN_ATTRIBUTES.MESSAGE_INTEGRITY, 0);
      integrityAttr.writeUInt16BE(integrity.length, 2);
      integrity.copy(integrityAttr, 4);

      attributesBuffer = Buffer.concat([attributesBuffer, integrityAttr]);
    }

    // Create final message
    const header = Buffer.alloc(20);
    header.writeUInt16BE(messageType, 0);
    header.writeUInt16BE(attributesBuffer.length, 2);
    header.writeUInt32BE(MAGIC_COOKIE, 4);
    transactionId.copy(header, 8);

    return Buffer.concat([header, attributesBuffer]);
  }

  /**
   * Create a string attribute
   * @param {number} type - Attribute type
   * @param {string} value - String value
   * @returns {Buffer} Attribute buffer
   * @private
   */
  _createStringAttribute(type, value) {
    const valueBuffer = Buffer.from(value, 'utf8');
    const length = valueBuffer.length;
    const padding = (4 - (length % 4)) % 4;
    const buffer = Buffer.alloc(4 + length + padding);
    
    buffer.writeUInt16BE(type, 0);
    buffer.writeUInt16BE(length, 2);
    valueBuffer.copy(buffer, 4);
    
    return buffer;
  }

  /**
   * Handle incoming STUN message
   * @param {Buffer} msg - Message buffer
   * @param {Object} rinfo - Remote info
   * @private
   */
  _handleMessage(msg, rinfo) {
    if (msg.length < 20) {
      return; // Invalid STUN message
    }

    const messageType = msg.readUInt16BE(0);
    const messageLength = msg.readUInt16BE(2);
    const magicCookie = msg.readUInt32BE(4);
    const transactionId = msg.slice(8, 20);

    if (magicCookie !== MAGIC_COOKIE) {
      return; // Not a STUN message
    }

    const transactionKey = transactionId.toString('hex');
    const transaction = this.transactions.get(transactionKey);

    if (!transaction) {
      return; // Unknown transaction
    }

    const attributes = this._parseAttributes(msg.slice(20, 20 + messageLength), transactionId);

    // Handle STUN Binding responses
    if (messageType === STUN_MESSAGE_TYPES.BINDING_RESPONSE) {
      if (attributes.xorMappedAddress) {
        transaction.resolve({
          address: attributes.xorMappedAddress.address,
          port: attributes.xorMappedAddress.port,
          family: attributes.xorMappedAddress.family
        });
      } else if (attributes.mappedAddress) {
        transaction.resolve({
          address: attributes.mappedAddress.address,
          port: attributes.mappedAddress.port,
          family: attributes.mappedAddress.family
        });
      } else {
        transaction.reject(new Error('No mapped address in STUN response'));
      }
      this.transactions.delete(transactionKey);
    }
    // Handle TURN Allocate responses
    else if (messageType === STUN_MESSAGE_TYPES.ALLOCATE_RESPONSE) {
      if (attributes.xorRelayedAddress) {
        transaction.resolve({
          relayedAddress: attributes.xorRelayedAddress.address,
          relayedPort: attributes.xorRelayedAddress.port,
          lifetime: attributes.lifetime || 600,
          type: 'relay'
        });
      } else {
        transaction.reject(new Error('No relayed address in ALLOCATE response'));
      }
      this.transactions.delete(transactionKey);
    }
    // Handle TURN Refresh responses
    else if (messageType === STUN_MESSAGE_TYPES.REFRESH_RESPONSE) {
      transaction.resolve({
        lifetime: attributes.lifetime || 600
      });
      this.transactions.delete(transactionKey);
    }
    // Handle Data Indication
    else if (messageType === STUN_MESSAGE_TYPES.DATA_INDICATION) {
      if (attributes.xorPeerAddress && attributes.data) {
        this.emit('data', attributes.data, {
          address: attributes.xorPeerAddress.address,
          port: attributes.xorPeerAddress.port,
          family: attributes.xorPeerAddress.family || 'IPv4'
        });
      }
    }
    // Handle error responses
    else if (messageType === STUN_MESSAGE_TYPES.BINDING_ERROR_RESPONSE ||
             messageType === STUN_MESSAGE_TYPES.ALLOCATE_ERROR_RESPONSE) {
      
      // Store realm and nonce for subsequent requests
      if (attributes.realm) {
        this.realm = attributes.realm;
      }
      if (attributes.nonce) {
        this.nonce = attributes.nonce;
      }

      const errorMsg = attributes.errorCode || 'Unknown error';
      transaction.reject(new Error(`STUN error: ${errorMsg}`));
      this.transactions.delete(transactionKey);
    }
  }

  /**
   * Parse STUN attributes
   * @param {Buffer} data - Attributes data
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Object} Parsed attributes
   * @private
   */
  _parseAttributes(data, transactionId) {
    const attributes = {};
    let offset = 0;

    while (offset < data.length) {
      if (offset + 4 > data.length) break;

      const type = data.readUInt16BE(offset);
      const length = data.readUInt16BE(offset + 2);
      offset += 4;

      if (offset + length > data.length) break;

      const value = data.slice(offset, offset + length);

      switch (type) {
        case STUN_ATTRIBUTES.XOR_MAPPED_ADDRESS:
          attributes.xorMappedAddress = this._parseXorAddress(value, transactionId);
          break;
        case STUN_ATTRIBUTES.XOR_RELAYED_ADDRESS:
          attributes.xorRelayedAddress = this._parseXorAddress(value, transactionId);
          break;
        case STUN_ATTRIBUTES.MAPPED_ADDRESS:
          attributes.mappedAddress = this._parseAddress(value);
          break;
        case STUN_ATTRIBUTES.LIFETIME:
          attributes.lifetime = value.readUInt32BE(0);
          break;
        case STUN_ATTRIBUTES.ERROR_CODE:
          attributes.errorCode = this._parseErrorCode(value);
          break;
        case STUN_ATTRIBUTES.REALM:
          attributes.realm = value.toString('utf8');
          this.realm = attributes.realm;
          break;
        case STUN_ATTRIBUTES.NONCE:
          attributes.nonce = value.toString('utf8');
          this.nonce = attributes.nonce;
          break;
      }

      // Pad to 4-byte boundary
      offset += length;
      const padding = (4 - (length % 4)) % 4;
      offset += padding;
    }

    return attributes;
  }

  /**
   * Parse XOR-MAPPED-ADDRESS attribute
   * @param {Buffer} data - Attribute data
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Object} Address info
   * @private
   */
  _parseXorAddress(data, transactionId) {
    const family = data.readUInt8(1);
    const xorPort = data.readUInt16BE(2);
    
    // XOR port with magic cookie high 16 bits
    const port = xorPort ^ (MAGIC_COOKIE >> 16);

    if (family === 0x01) { // IPv4
      const xorAddress = data.readUInt32BE(4);
      const address = xorAddress ^ MAGIC_COOKIE;
      
      return {
        family: 'IPv4',
        port,
        address: [
          (address >> 24) & 0xFF,
          (address >> 16) & 0xFF,
          (address >> 8) & 0xFF,
          address & 0xFF
        ].join('.')
      };
    }

    return null;
  }

  /**
   * Parse MAPPED-ADDRESS attribute
   * @param {Buffer} data - Attribute data
   * @returns {Object} Address info
   * @private
   */
  _parseAddress(data) {
    const family = data.readUInt8(1);
    const port = data.readUInt16BE(2);

    if (family === 0x01) { // IPv4
      const address = data.slice(4, 8);
      return {
        family: 'IPv4',
        port,
        address: Array.from(address).join('.')
      };
    }

    return null;
  }

  /**
   * Parse ERROR-CODE attribute
   * @param {Buffer} data - Attribute data
   * @returns {string} Error message
   * @private
   */
  _parseErrorCode(data) {
    const errorClass = data.readUInt8(2) & 0x07;
    const errorNumber = data.readUInt8(3);
    const errorCode = errorClass * 100 + errorNumber;
    const reason = data.slice(4).toString('utf8');
    
    return `${errorCode} ${reason}`;
  }

  /**
   * Close the client
   */
  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.transactions.clear();
  }
}

module.exports = STUNClient;
