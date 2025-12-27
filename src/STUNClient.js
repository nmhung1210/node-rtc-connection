/**
 * STUN Client Implementation (RFC 5389)
 * Pure Node.js implementation using dgram
 */

const dgram = require('dgram');
const crypto = require('crypto');

// STUN Message Types
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;

// STUN Attributes
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

// STUN Magic Cookie
const MAGIC_COOKIE = 0x2112A442;

class STUNClient {
  constructor() {
    this.socket = null;
    this.timeout = 5000;
  }

  /**
   * Get public IP and port by querying STUN server
   * @param {string} stunServer - STUN server address (e.g., 'stun.l.google.com:19302')
   * @returns {Promise<{ip: string, port: number, type: string}>}
   */
  async getReflexiveAddress(stunServer = 'stun.l.google.com:19302') {
    return new Promise((resolve, reject) => {
      const [host, portStr] = stunServer.split(':');
      const port = parseInt(portStr, 10);

      // Create UDP socket
      this.socket = dgram.createSocket('udp4');
      
      const transactionId = crypto.randomBytes(12);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.socket.close();
          reject(new Error('STUN request timeout'));
        }
      }, this.timeout);

      this.socket.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.socket.close();
          reject(err);
        }
      });

      this.socket.on('message', (msg) => {
        if (resolved) return;

        try {
          const result = this._parseSTUNResponse(msg, transactionId);
          if (result) {
            resolved = true;
            clearTimeout(timeout);
            this.socket.close();
            resolve(result);
          }
        } catch (err) {
          resolved = true;
          clearTimeout(timeout);
          this.socket.close();
          reject(err);
        }
      });

      // Send STUN Binding Request
      const request = this._createBindingRequest(transactionId);
      this.socket.send(request, port, host, (err) => {
        if (err && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.socket.close();
          reject(err);
        }
      });
    });
  }

  /**
   * Create STUN Binding Request
   * @private
   */
  _createBindingRequest(transactionId) {
    const buffer = Buffer.allocUnsafe(20);
    
    // Message Type (2 bytes)
    buffer.writeUInt16BE(STUN_BINDING_REQUEST, 0);
    
    // Message Length (2 bytes) - 0 for no attributes
    buffer.writeUInt16BE(0, 2);
    
    // Magic Cookie (4 bytes)
    buffer.writeUInt32BE(MAGIC_COOKIE, 4);
    
    // Transaction ID (12 bytes)
    transactionId.copy(buffer, 8);
    
    return buffer;
  }

  /**
   * Parse STUN Response
   * @private
   */
  _parseSTUNResponse(msg, expectedTransactionId) {
    if (msg.length < 20) {
      throw new Error('Invalid STUN response: too short');
    }

    const messageType = msg.readUInt16BE(0);
    const messageLength = msg.readUInt16BE(2);
    const magicCookie = msg.readUInt32BE(4);
    const transactionId = msg.slice(8, 20);

    // Verify this is a binding response
    if (messageType !== STUN_BINDING_RESPONSE) {
      return null;
    }

    // Verify magic cookie
    if (magicCookie !== MAGIC_COOKIE) {
      throw new Error('Invalid STUN response: bad magic cookie');
    }

    // Verify transaction ID
    if (!transactionId.equals(expectedTransactionId)) {
      return null;
    }

    // Parse attributes
    let offset = 20;
    while (offset < 20 + messageLength) {
      const attrType = msg.readUInt16BE(offset);
      const attrLength = msg.readUInt16BE(offset + 2);
      const attrValue = msg.slice(offset + 4, offset + 4 + attrLength);

      if (attrType === ATTR_XOR_MAPPED_ADDRESS) {
        return this._parseXorMappedAddress(attrValue, transactionId);
      } else if (attrType === ATTR_MAPPED_ADDRESS) {
        return this._parseMappedAddress(attrValue);
      }

      // Move to next attribute (with padding)
      offset += 4 + attrLength;
      if (attrLength % 4 !== 0) {
        offset += 4 - (attrLength % 4);
      }
    }

    throw new Error('No mapped address in STUN response');
  }

  /**
   * Parse XOR-MAPPED-ADDRESS attribute
   * @private
   */
  _parseXorMappedAddress(value, transactionId) {
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

    return {
      ip,
      port,
      type: 'srflx' // Server Reflexive
    };
  }

  /**
   * Parse MAPPED-ADDRESS attribute
   * @private
   */
  _parseMappedAddress(value) {
    const family = value.readUInt8(1);
    const port = value.readUInt16BE(2);
    const addressBytes = value.slice(4, 8);
    const ip = Array.from(addressBytes).join('.');

    return {
      ip,
      port,
      type: 'srflx'
    };
  }

  /**
   * Close the socket
   */
  close() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}

module.exports = STUNClient;
