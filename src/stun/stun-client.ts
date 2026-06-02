/**
 * @file stun-client.ts
 * @description STUN (Session Traversal Utilities for NAT) client implementation
 * @module stun/stun-client
 *
 * STUN Protocol: RFC 5389
 * TURN Protocol: RFC 5766
 */

'use strict';

import * as dgram from 'dgram';
import * as tls from 'tls';
import * as crypto from 'crypto';

import { EventEmitter } from 'events';

import { DtlsConnection, ROLE } from '../dtls/connection';
import * as x509 from '../crypto/x509';

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
  CHANNEL_BIND_RESPONSE: 0x0109,
} as const;

/**
 * STUN attribute types
 */
const STUN_ATTRIBUTES = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  UNKNOWN_ATTRIBUTES: 0x000a,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_MAPPED_ADDRESS: 0x0020,

  // TURN
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,

  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
} as const;

const MAGIC_COOKIE = 0x2112a442;

/**
 * Constructor options for {@link STUNClient}.
 */
interface STUNClientOptions {
  /** STUN/TURN server address */
  server: string;
  /** Server port */
  port: number;
  /** TURN username */
  username?: string;
  /** TURN password */
  credential?: string;
  /** Transport protocol (udp/tcp) */
  transport?: string;
  /** Wrap the link to the server in DTLS (TURN-over-DTLS, the `turns:` scheme) */
  secure?: boolean;
  /** Additional query parameters from URL */
  params?: Record<string, unknown>;
}

/**
 * Parsed IPv4 address info.
 */
interface AddressInfo {
  family: string;
  port: number;
  address: string;
}

/**
 * Reflexive address info resolved from a STUN Binding response.
 */
interface ReflexiveAddress {
  address: string;
  port: number;
  family: string;
}

/**
 * Relay address info resolved from a TURN Allocate response.
 */
interface RelayAddress {
  relayedAddress: string;
  relayedPort: number;
  lifetime: number;
  type: 'relay';
}

/**
 * Result of a TURN Refresh response.
 */
interface RefreshResult {
  lifetime: number;
}

/**
 * Result of a generic success response (CreatePermission / ChannelBind).
 */
interface OkResult {
  ok: true;
}

/**
 * Union of every result shape a transaction may resolve with.
 */
type TransactionResult = ReflexiveAddress | RelayAddress | RefreshResult | OkResult;

/**
 * A pending request transaction.
 */
interface Transaction {
  type?: string;
  resolve: (result: TransactionResult) => void;
  reject: (error: Error) => void;
}

/**
 * Parsed STUN attributes object.
 */
interface ParsedAttributes {
  xorMappedAddress?: AddressInfo | null;
  xorRelayedAddress?: AddressInfo | null;
  xorPeerAddress?: AddressInfo | null;
  mappedAddress?: AddressInfo | null;
  data?: Buffer;
  lifetime?: number;
  errorCode?: string;
  realm?: string;
  nonce?: string;
}

/**
 * Payload emitted with the 'data' event for relayed peer data.
 */
interface DataEventInfo {
  address: string;
  port: number;
  family: string;
}

/**
 * Build product passed back from a request builder used with auth retry.
 */
interface RequestBuild {
  transactionId: Buffer;
  request: Buffer;
}

/**
 * @class STUNClient
 * @description STUN/TURN client for NAT traversal
 */
class STUNClient extends EventEmitter {
  #server: string;
  #port: number;
  #username: string | undefined;
  #credential: string | undefined;
  #socket: dgram.Socket | null;
  #transactions: Map<string, Transaction>;
  #realm: string | null;
  #nonce: string | null;
  #secure: boolean;
  #transport: string;
  #dtls: DtlsConnection | null;
  #tls: tls.TLSSocket | null;
  #streamBuffer: Buffer;

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
  constructor(options: STUNClientOptions) {
    super();
    this.#server = options.server;
    this.#port = options.port;
    this.#username = options.username;
    this.#credential = options.credential;

    this.#socket = null;
    this.#transactions = new Map();
    this.#realm = null;
    this.#nonce = null;
    this.#secure = options.secure === true;
    this.#transport = (options.transport || 'udp').toLowerCase();
    this.#dtls = null;
    this.#tls = null;
    this.#streamBuffer = Buffer.alloc(0);
  }

  /**
   * Connect to the STUN/TURN server
   * @returns {Promise<void>}
   */
  async connect(): Promise<void> {
    if (this.#socket || this.#tls) {
      return;
    }

    // TURN-over-TLS: a TLS byte stream over TCP (the turns: scheme with
    // ?transport=tcp). Node's tls module handles the handshake; we only need to
    // re-frame the inbound stream into discrete STUN messages on read.
    if (this.#secure && this.#transport === 'tcp') {
      return this.#connectTls();
    }

    return new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      this.#socket = socket;

      socket.on('error', (err: Error) => {
        console.error('STUN socket error:', err);
        reject(err);
      });

      if (this.#secure) {
        // TURN-over-DTLS: wrap the link to the server in a DTLS 1.2 session.
        // Inbound datagrams are DTLS records → decrypted application data is the
        // STUN/TURN message stream. The server does not request a client cert,
        // so we only need an ephemeral cert to satisfy the handshake.
        const cert = x509.generateSelfSigned({ commonName: 'nodertc-turn-client' });
        const dtls = new DtlsConnection({
          role: ROLE.CLIENT,
          certDer: cert.certDer,
          privateKey: cert.privateKey,
          verifyFingerprint: () => true, // no SDP fingerprint to pin for a TURN server
          output: (datagram: Buffer) => {
            socket.send(datagram, this.#port, this.#server, () => {});
          },
        });
        this.#dtls = dtls;

        socket.on('message', (msg: Buffer) => dtls.handlePacket(msg));
        dtls.on('data', (data: Buffer) => this.#handleMessage(data, this.#fakeRinfo()));
        dtls.on('connect', () => resolve());
        dtls.on('error', (err: Error) => reject(err));

        socket.bind(() => dtls.start());
      } else {
        socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
          this.#handleMessage(msg, rinfo);
        });
        socket.bind(() => resolve());
      }
    });
  }

  /**
   * Open a TLS connection to the TURN server and wire its byte stream into the
   * STUN message handler. The server does not validate a client certificate,
   * and it is self-signed, so we disable peer verification (an encrypted
   * channel to the TURN server is the only goal — relayed payloads carry their
   * own end-to-end DTLS).
   * @private
   */
  #connectTls(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = tls.connect(
        { host: this.#server, port: this.#port, rejectUnauthorized: false },
        () => resolve()
      );
      this.#tls = socket;
      socket.on('data', (chunk: Buffer) => this.#onStreamData(chunk));
      socket.on('error', (err: Error) => reject(err));
    });
  }

  /**
   * Re-frame a TLS/TCP byte stream into STUN messages. Each STUN message is a
   * 20-byte header followed by `length` bytes (the big-endian uint16 at offset
   * 2); we buffer partial reads and dispatch each complete message.
   * @param chunk - bytes received from the stream
   * @private
   */
  #onStreamData(chunk: Buffer): void {
    this.#streamBuffer = this.#streamBuffer.length ? Buffer.concat([this.#streamBuffer, chunk]) : chunk;
    while (this.#streamBuffer.length >= 20) {
      const messageLength = this.#streamBuffer.readUInt16BE(2);
      const total = 20 + messageLength;
      if (this.#streamBuffer.length < total) break; // wait for the rest
      const message = this.#streamBuffer.subarray(0, total);
      this.#streamBuffer = this.#streamBuffer.subarray(total);
      this.#handleMessage(message, this.#fakeRinfo());
    }
  }

  /** A placeholder RemoteInfo for DTLS/TLS-delivered messages (rinfo is unused). */
  #fakeRinfo(): dgram.RemoteInfo {
    return { address: this.#server, family: 'IPv4', port: this.#port, size: 0 };
  }

  /**
   * Send a datagram to the server over whichever transport is active: the DTLS
   * session when secure, otherwise the bare UDP socket. `onError` is invoked if
   * the send fails (UDP delivers the error via callback; DTLS via throw).
   * @param buf - bytes to send
   * @param onError - called with the error on failure
   * @private
   */
  #sendToServer(buf: Buffer, onError: (err: Error) => void): void {
    if (this.#tls) {
      this.#tls.write(buf, (err) => {
        if (err) onError(err);
      });
      return;
    }
    if (this.#dtls) {
      try {
        this.#dtls.send(buf);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    this.#socket!.send(buf, this.#port, this.#server, (err) => {
      if (err) onError(err);
    });
  }

  /**
   * Send a STUN Binding Request to get reflexive address
   * @returns {Promise<Object>} Reflexive address info
   */
  async getReflexiveAddress(): Promise<TransactionResult> {
    await this.connect();

    const transactionId = crypto.randomBytes(12);
    const request = this.#createBindingRequest(transactionId);

    return new Promise<TransactionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#transactions.delete(transactionId.toString('hex'));
        reject(new Error('STUN request timeout'));
      }, 5000);

      this.#transactions.set(transactionId.toString('hex'), {
        resolve: (result: TransactionResult) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.#sendToServer(request, (err) => {
        clearTimeout(timeout);
        this.#transactions.delete(transactionId.toString('hex'));
        reject(err);
      });
    });
  }

  /**
   * Send a TURN Allocate Request to get relay address
   * @param {number} [lifetime=600] - Allocation lifetime in seconds
   * @returns {Promise<Object>} Relay address info
   */
  async allocateRelay(lifetime: number = 600): Promise<TransactionResult> {
    if (!this.#username || !this.#credential) {
      throw new Error('TURN requires username and credential');
    }

    await this.connect();

    let transactionId = crypto.randomBytes(12);
    let request = this.#createAllocateRequest(transactionId, lifetime);

    // First attempt without credentials to get realm and nonce
    try {
      return await this.#sendRequest(request, transactionId, 'allocate');
    } catch (error) {
      // If we get 401 Unauthorized, retry with credentials
      if (error instanceof Error && error.message.includes('401') && this.#realm && this.#nonce) {
        // Create new transaction ID for retry
        transactionId = crypto.randomBytes(12);
        request = this.#createAllocateRequest(transactionId, lifetime, true);
        return await this.#sendRequest(request, transactionId, 'allocate');
      }
      throw error;
    }
  }

  /**
   * Send a TURN Refresh Request to keep allocation alive
   * @param {number} [lifetime=600] - Allocation lifetime in seconds
   * @returns {Promise<Object>} Updated allocation info
   */
  async refreshAllocation(lifetime: number = 600): Promise<TransactionResult> {
    if (!this.#username || !this.#credential) {
      throw new Error('TURN requires username and credential');
    }

    return this.#withAuthRetry('refresh', () => {
      const transactionId = crypto.randomBytes(12);
      return { transactionId, request: this.#createRefreshRequest(transactionId, lifetime) };
    });
  }

  /**
   * Send an authenticated TURN request, retrying once on a 401 (stale-nonce or
   * first-time challenge) after refreshing realm/nonce from the error.
   * @param {string} type - request label for diagnostics
   * @param {() => {transactionId: Buffer, request: Buffer}} build
   * @returns {Promise<Object>}
   * @private
   */
  async #withAuthRetry(type: string, build: () => RequestBuild): Promise<TransactionResult> {
    const first = build();
    try {
      return await this.#sendRequest(first.request, first.transactionId, type);
    } catch (error) {
      if (error instanceof Error && error.message.includes('401') && this.#realm && this.#nonce) {
        const retry = build(); // rebuilt with the refreshed realm/nonce
        return this.#sendRequest(retry.request, retry.transactionId, type);
      }
      throw error;
    }
  }

  /**
   * Create a TURN Permission for a peer
   * @param {string} peerAddress - Peer IP address
   * @returns {Promise<void>}
   */
  async createPermission(peerAddress: string): Promise<void> {
    if (!this.#username || !this.#credential) {
      throw new Error('TURN requires username and credential');
    }

    await this.#withAuthRetry('createPermission', () => {
      const transactionId = crypto.randomBytes(12);
      return { transactionId, request: this.#createCreatePermissionRequest(transactionId, peerAddress) };
    });
  }

  /**
   * Send data to a peer via TURN Send Indication
   * @param {string} peerAddress - Peer IP address
   * @param {number} peerPort - Peer port
   * @param {Buffer} data - Data to send
   * @returns {Promise<void>}
   */
  async sendIndication(peerAddress: string, peerPort: number, data: Buffer): Promise<void> {
    if (!this.#username || !this.#credential) {
      throw new Error('TURN requires username and credential');
    }

    const transactionId = crypto.randomBytes(12);
    const indication = this.#createSendIndication(transactionId, peerAddress, peerPort, data);

    // Indications are fire-and-forget, no response expected
    return new Promise<void>((resolve, reject) => {
      this.#sendToServer(indication, reject);
      resolve();
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
  #sendRequest(request: Buffer, transactionId: Buffer, requestType: string): Promise<TransactionResult> {
    return new Promise<TransactionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#transactions.delete(transactionId.toString('hex'));
        reject(new Error(`${requestType} request timeout`));
      }, 5000);

      this.#transactions.set(transactionId.toString('hex'), {
        type: requestType,
        resolve: (result: TransactionResult) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.#sendToServer(request, (err) => {
        clearTimeout(timeout);
        this.#transactions.delete(transactionId.toString('hex'));
        reject(err);
      });
    });
  }

  /**
   * Create a STUN Binding Request
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Buffer} STUN message
   * @private
   */
  #createBindingRequest(transactionId: Buffer): Buffer {
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
  #createAllocateRequest(transactionId: Buffer, lifetime: number, withAuth: boolean = false): Buffer {
    const attributes: Buffer[] = [];

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

    if (withAuth && this.#realm && this.#nonce) {
      // USERNAME
      const usernameAttr = this.#createStringAttribute(STUN_ATTRIBUTES.USERNAME, this.#username!);
      attributes.push(usernameAttr);

      // REALM
      const realmAttr = this.#createStringAttribute(STUN_ATTRIBUTES.REALM, this.#realm);
      attributes.push(realmAttr);

      // NONCE
      const nonceAttr = this.#createStringAttribute(STUN_ATTRIBUTES.NONCE, this.#nonce);
      attributes.push(nonceAttr);
    }

    return this.#createMessage(STUN_MESSAGE_TYPES.ALLOCATE_REQUEST, transactionId, attributes, withAuth);
  }

  /**
   * Create a TURN CreatePermission Request
   * @param {Buffer} transactionId - Transaction ID
   * @param {string} peerAddress - Peer IP address
   * @returns {Buffer} STUN message
   * @private
   */
  #createCreatePermissionRequest(transactionId: Buffer, peerAddress: string): Buffer {
    const attributes: Buffer[] = [];

    // XOR-PEER-ADDRESS
    const peerAttr = this.#createXorPeerAddressAttribute(peerAddress, 0, transactionId);
    attributes.push(peerAttr);

    // Auth attributes
    if (this.#realm && this.#nonce) {
      attributes.push(this.#createStringAttribute(STUN_ATTRIBUTES.USERNAME, this.#username!));
      attributes.push(this.#createStringAttribute(STUN_ATTRIBUTES.REALM, this.#realm));
      attributes.push(this.#createStringAttribute(STUN_ATTRIBUTES.NONCE, this.#nonce));
    }

    return this.#createMessage(STUN_MESSAGE_TYPES.CREATE_PERMISSION_REQUEST, transactionId, attributes, true);
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
  #createSendIndication(transactionId: Buffer, peerAddress: string, peerPort: number, data: Buffer): Buffer {
    const attributes: Buffer[] = [];

    // XOR-PEER-ADDRESS
    const peerAttr = this.#createXorPeerAddressAttribute(peerAddress, peerPort, transactionId);
    attributes.push(peerAttr);

    // DATA
    const dataAttr = Buffer.alloc(4 + data.length + ((4 - (data.length % 4)) % 4));
    dataAttr.writeUInt16BE(STUN_ATTRIBUTES.DATA, 0);
    dataAttr.writeUInt16BE(data.length, 2);
    data.copy(dataAttr, 4);
    attributes.push(dataAttr);

    return this.#createMessage(STUN_MESSAGE_TYPES.SEND_INDICATION, transactionId, attributes, false);
  }

  /**
   * Create XOR-PEER-ADDRESS attribute
   * @param {string} address - IP address
   * @param {number} port - Port
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Buffer} Attribute buffer
   * @private
   */
  #createXorPeerAddressAttribute(address: string, port: number, _transactionId: Buffer): Buffer {
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
    const addrInt = (parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
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
  #createRefreshRequest(transactionId: Buffer, lifetime: number): Buffer {
    const attributes: Buffer[] = [];

    // LIFETIME
    const lifetimeAttr = Buffer.alloc(8);
    lifetimeAttr.writeUInt16BE(STUN_ATTRIBUTES.LIFETIME, 0);
    lifetimeAttr.writeUInt16BE(4, 2);
    lifetimeAttr.writeUInt32BE(lifetime, 4);
    attributes.push(lifetimeAttr);

    // USERNAME
    const usernameAttr = this.#createStringAttribute(STUN_ATTRIBUTES.USERNAME, this.#username!);
    attributes.push(usernameAttr);

    // REALM
    if (this.#realm) {
      const realmAttr = this.#createStringAttribute(STUN_ATTRIBUTES.REALM, this.#realm);
      attributes.push(realmAttr);
    }

    // NONCE
    if (this.#nonce) {
      const nonceAttr = this.#createStringAttribute(STUN_ATTRIBUTES.NONCE, this.#nonce);
      attributes.push(nonceAttr);
    }

    return this.#createMessage(STUN_MESSAGE_TYPES.REFRESH_REQUEST, transactionId, attributes, true);
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
  #createMessage(
    messageType: number,
    transactionId: Buffer,
    attributes: Buffer[],
    withIntegrity: boolean = false
  ): Buffer {
    let attributesBuffer = Buffer.concat(attributes);

    // Add MESSAGE-INTEGRITY if needed
    if (withIntegrity && this.#credential) {
      const tempHeader = Buffer.alloc(20);
      tempHeader.writeUInt16BE(messageType, 0);
      tempHeader.writeUInt16BE(attributesBuffer.length + 24, 2); // +24 for MESSAGE-INTEGRITY
      tempHeader.writeUInt32BE(MAGIC_COOKIE, 4);
      transactionId.copy(tempHeader, 8);

      const tempMessage = Buffer.concat([tempHeader, attributesBuffer]);

      // For TURN, compute key from username:realm:password using SHA-256
      let key: string | Buffer = this.#credential;
      if (this.#username && this.#realm) {
        const keyString = `${this.#username}:${this.#realm}:${this.#credential}`;
        key = crypto.createHash('sha256').update(keyString).digest();
      }

      const hmac = crypto.createHmac('sha256', key);
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
  #createStringAttribute(type: number, value: string): Buffer {
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
  #handleMessage(msg: Buffer, _rinfo: dgram.RemoteInfo): void {
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

    // DATA indications are server-initiated (relayed peer data) and carry a
    // fresh transaction id that matches no pending request — handle them before
    // the transaction lookup.
    if (messageType === STUN_MESSAGE_TYPES.DATA_INDICATION) {
      const attrs = this.#parseAttributes(msg.slice(20, 20 + messageLength), transactionId);
      if (attrs.xorPeerAddress && attrs.data) {
        const info: DataEventInfo = {
          address: attrs.xorPeerAddress.address,
          port: attrs.xorPeerAddress.port,
          family: attrs.xorPeerAddress.family || 'IPv4',
        };
        this.emit('data', attrs.data, info);
      }
      return;
    }

    const transactionKey = transactionId.toString('hex');
    const transaction = this.#transactions.get(transactionKey);

    if (!transaction) {
      return; // Unknown transaction
    }

    const attributes = this.#parseAttributes(msg.slice(20, 20 + messageLength), transactionId);

    // Handle STUN Binding responses
    if (messageType === STUN_MESSAGE_TYPES.BINDING_RESPONSE) {
      if (attributes.xorMappedAddress) {
        transaction.resolve({
          address: attributes.xorMappedAddress.address,
          port: attributes.xorMappedAddress.port,
          family: attributes.xorMappedAddress.family,
        });
      } else if (attributes.mappedAddress) {
        transaction.resolve({
          address: attributes.mappedAddress.address,
          port: attributes.mappedAddress.port,
          family: attributes.mappedAddress.family,
        });
      } else {
        transaction.reject(new Error('No mapped address in STUN response'));
      }
      this.#transactions.delete(transactionKey);
    }
    // Handle TURN Allocate responses
    else if (messageType === STUN_MESSAGE_TYPES.ALLOCATE_RESPONSE) {
      if (attributes.xorRelayedAddress) {
        transaction.resolve({
          relayedAddress: attributes.xorRelayedAddress.address,
          relayedPort: attributes.xorRelayedAddress.port,
          lifetime: attributes.lifetime || 600,
          type: 'relay',
        });
      } else {
        transaction.reject(new Error('No relayed address in ALLOCATE response'));
      }
      this.#transactions.delete(transactionKey);
    }
    // Handle TURN Refresh responses
    else if (messageType === STUN_MESSAGE_TYPES.REFRESH_RESPONSE) {
      transaction.resolve({
        lifetime: attributes.lifetime || 600,
      });
      this.#transactions.delete(transactionKey);
    }
    // Handle TURN CreatePermission / ChannelBind success responses
    else if (
      messageType === STUN_MESSAGE_TYPES.CREATE_PERMISSION_RESPONSE ||
      messageType === STUN_MESSAGE_TYPES.CHANNEL_BIND_RESPONSE
    ) {
      transaction.resolve({ ok: true });
      this.#transactions.delete(transactionKey);
    }
    // (DATA indications are handled earlier, before the transaction lookup.)
    // Handle error responses generically: any class-of-error message
    // (the 0x0110 bits set). This covers ALLOCATE (0x0113), CreatePermission
    // (0x0118), Refresh (0x0114), Binding (0x0111), etc.
    else if ((messageType & 0x0110) === 0x0110) {
      // Store realm and nonce so the caller can retry with fresh credentials.
      if (attributes.realm) {
        this.#realm = attributes.realm;
      }
      if (attributes.nonce) {
        this.#nonce = attributes.nonce;
      }

      const errorMsg = attributes.errorCode || 'Unknown error';
      transaction.reject(new Error(`STUN error: ${errorMsg}`));
      this.#transactions.delete(transactionKey);
    }
  }

  /**
   * Parse STUN attributes
   * @param {Buffer} data - Attributes data
   * @param {Buffer} transactionId - Transaction ID
   * @returns {Object} Parsed attributes
   * @private
   */
  #parseAttributes(data: Buffer, transactionId: Buffer): ParsedAttributes {
    const attributes: ParsedAttributes = {};
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
          attributes.xorMappedAddress = this.#parseXorAddress(value, transactionId);
          break;
        case STUN_ATTRIBUTES.XOR_RELAYED_ADDRESS:
          attributes.xorRelayedAddress = this.#parseXorAddress(value, transactionId);
          break;
        case STUN_ATTRIBUTES.XOR_PEER_ADDRESS:
          attributes.xorPeerAddress = this.#parseXorAddress(value, transactionId);
          break;
        case STUN_ATTRIBUTES.DATA:
          attributes.data = value;
          break;
        case STUN_ATTRIBUTES.MAPPED_ADDRESS:
          attributes.mappedAddress = this.#parseAddress(value);
          break;
        case STUN_ATTRIBUTES.LIFETIME:
          attributes.lifetime = value.readUInt32BE(0);
          break;
        case STUN_ATTRIBUTES.ERROR_CODE:
          attributes.errorCode = this.#parseErrorCode(value);
          break;
        case STUN_ATTRIBUTES.REALM:
          attributes.realm = value.toString('utf8');
          this.#realm = attributes.realm;
          break;
        case STUN_ATTRIBUTES.NONCE:
          attributes.nonce = value.toString('utf8');
          this.#nonce = attributes.nonce;
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
  #parseXorAddress(data: Buffer, _transactionId: Buffer): AddressInfo | null {
    const family = data.readUInt8(1);
    const xorPort = data.readUInt16BE(2);

    // XOR port with magic cookie high 16 bits
    const port = xorPort ^ (MAGIC_COOKIE >> 16);

    if (family === 0x01) {
      // IPv4
      const xorAddress = data.readUInt32BE(4);
      const address = xorAddress ^ MAGIC_COOKIE;

      return {
        family: 'IPv4',
        port,
        address: [(address >> 24) & 0xff, (address >> 16) & 0xff, (address >> 8) & 0xff, address & 0xff].join('.'),
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
  #parseAddress(data: Buffer): AddressInfo | null {
    const family = data.readUInt8(1);
    const port = data.readUInt16BE(2);

    if (family === 0x01) {
      // IPv4
      const address = data.slice(4, 8);
      return {
        family: 'IPv4',
        port,
        address: Array.from(address).join('.'),
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
  #parseErrorCode(data: Buffer): string {
    const errorClass = data.readUInt8(2) & 0x07;
    const errorNumber = data.readUInt8(3);
    const errorCode = errorClass * 100 + errorNumber;
    const reason = data.slice(4).toString('utf8');

    return `${errorCode} ${reason}`;
  }

  /**
   * Close the client
   */
  close(): void {
    if (this.#dtls) {
      try { this.#dtls.close(); } catch (_) {}
      this.#dtls = null;
    }
    if (this.#tls) {
      try { this.#tls.destroy(); } catch (_) {}
      this.#tls = null;
    }
    if (this.#socket) {
      this.#socket.close();
      this.#socket = null;
    }
    this.#transactions.clear();
  }
}

export default STUNClient;
export { STUNClient };
