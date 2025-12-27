/**
 * UDP Transport with DTLS-like encryption
 * Alternative to TCP for lower latency
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const { DTLSConnection } = require('./SecureConnection');

class UDPTransport extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.socket = dgram.createSocket('udp4');
    this.localPort = options.localPort || 0;
    this.remoteAddress = null;
    this.remotePort = null;
    this.dtls = null;
    this.useEncryption = options.encrypted !== false;
    this.channels = new Map(); // label -> channel info
    this.messageBuffer = Buffer.alloc(0);
  }

  /**
   * Start listening on local port
   */
  async listen() {
    return new Promise((resolve, reject) => {
      this.socket.on('error', (err) => {
        this.emit('error', err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this._handleMessage(msg, rinfo);
      });

      this.socket.bind(this.localPort, () => {
        const addr = this.socket.address();
        this.localPort = addr.port;
        this.emit('listening', addr);
        resolve(addr);
      });
    });
  }

  /**
   * Connect to remote peer
   */
  async connect(address, port) {
    this.remoteAddress = address;
    this.remotePort = port;

    if (this.useEncryption) {
      // Initialize DTLS
      this.dtls = new DTLSConnection({ isServer: false });
      
      await this.dtls.handshake((key) => {
        // Send encryption key to remote
        this._sendRaw(Buffer.concat([
          Buffer.from([0x01]), // Key exchange message
          key
        ]));
      });

      await new Promise(resolve => {
        this.dtls.once('ready', resolve);
      });
    }

    this.emit('connected');
  }

  /**
   * Handle incoming message
   * @private
   */
  _handleMessage(msg, rinfo) {
    // Set remote address on first message
    if (!this.remoteAddress) {
      this.remoteAddress = rinfo.address;
      this.remotePort = rinfo.port;
    }

    // Check if this is a key exchange message
    if (msg[0] === 0x01 && msg.length >= 33) {
      const key = msg.slice(1, 33);
      
      if (!this.dtls) {
        this.dtls = new DTLSConnection({ isServer: true });
        
        // Send our key back
        this._sendRaw(Buffer.concat([
          Buffer.from([0x01]),
          this.dtls.key
        ]));
      }
      
      this.dtls.setRemoteKey(key);
      this.emit('connected');
      return;
    }

    // Decrypt if encryption is enabled
    let data = msg;
    if (this.useEncryption && this.dtls && this.dtls.ready) {
      try {
        data = this.dtls.decrypt(msg);
      } catch (err) {
        console.error('Decryption failed:', err.message);
        return;
      }
    }

    // Parse the message
    this._parseMessage(data);
  }

  /**
   * Parse data channel message
   * @private
   */
  _parseMessage(data) {
    // Message format: <length:4><label-length:2><label><data>
    if (data.length < 6) return;

    try {
      const totalLength = data.readUInt32BE(0);
      const labelLength = data.readUInt16BE(4);
      
      if (data.length < 6 + labelLength) return;
      
      const label = data.slice(6, 6 + labelLength).toString('utf8');
      const messageData = data.slice(6 + labelLength);

      // Get or create channel
      if (!this.channels.has(label)) {
        this.emit('channel', { label });
      }

      // Emit message event
      this.emit('message', { label, data: messageData });

    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  }

  /**
   * Send message on a data channel
   */
  send(label, data) {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const labelBuffer = Buffer.from(label, 'utf8');
    
    const totalLength = 2 + labelBuffer.length + dataBuffer.length;
    const message = Buffer.allocUnsafe(4 + totalLength);
    
    message.writeUInt32BE(totalLength, 0);
    message.writeUInt16BE(labelBuffer.length, 4);
    labelBuffer.copy(message, 6);
    dataBuffer.copy(message, 6 + labelBuffer.length);

    this._sendRaw(message);
  }

  /**
   * Send raw data (with optional encryption)
   * @private
   */
  _sendRaw(data) {
    if (!this.remoteAddress || !this.remotePort) {
      throw new Error('Remote address not set');
    }

    let sendData = data;
    
    // Encrypt if encryption is enabled
    if (this.useEncryption && this.dtls && this.dtls.ready) {
      sendData = this.dtls.encrypt(data);
    }

    this.socket.send(sendData, this.remotePort, this.remoteAddress, (err) => {
      if (err) {
        this.emit('error', err);
      }
    });
  }

  /**
   * Create a data channel
   */
  createChannel(label) {
    if (!this.channels.has(label)) {
      this.channels.set(label, { label, created: Date.now() });
      
      // Announce channel to remote peer
      this.send(label, Buffer.alloc(0));
    }
  }

  /**
   * Get local address
   */
  address() {
    return this.socket.address();
  }

  /**
   * Get fingerprint (for SDP)
   */
  getFingerprint() {
    if (this.dtls) {
      return this.dtls.getFingerprint();
    }
    return 'NO:EN:CR:YP:TI:ON';
  }

  /**
   * Close the transport
   */
  close() {
    if (this.dtls) {
      this.dtls.removeAllListeners();
      this.dtls = null;
    }
    
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    
    this.channels.clear();
  }
}

module.exports = UDPTransport;
