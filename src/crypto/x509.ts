/**
 * @file x509.ts
 * @description Self-signed X.509 v3 certificate generation for WebRTC DTLS.
 * @module crypto/x509
 *
 * WebRTC peers authenticate by self-signed certificate. The SDP carries
 * a=fingerprint as the hash of the DER-encoded certificate (RFC 8122), which
 * the peer verifies against the certificate presented during the DTLS
 * handshake. Node has no certificate builder, so we assemble a minimal but
 * spec-valid ECDSA P-256 / ecdsa-with-SHA256 certificate by hand.
 */

'use strict';

import * as crypto from 'crypto';
import * as der from './der';

/**
 * Options for {@link generateSelfSigned}.
 */
export interface GenerateSelfSignedOptions {
  /** CN; WebRTC uses a random value. */
  commonName?: string;
  /** Validity period in days. */
  days?: number;
  /** Override start time (default: now - 1 day). */
  notBefore?: Date;
}

/**
 * Result of {@link generateSelfSigned}.
 */
export interface SelfSignedCertificate {
  /** DER-encoded certificate. */
  certDer: Buffer;
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  notBefore: Date;
  notAfter: Date;
}

// OIDs used in the certificate.
export const OID = Object.freeze({
  ecPublicKey: '1.2.840.10045.2.1',
  prime256v1: '1.2.840.10045.3.1.7',
  ecdsaWithSHA256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
});

/**
 * Build a Name with a single CN RDN.
 * @param {string} cn
 * @returns {Buffer}
 */
function buildName(cn: string): Buffer {
  const attr = der.encodeSequence([
    der.encodeOID(OID.commonName),
    der.encodeUTF8String(cn),
  ]);
  const rdn = der.encodeSet([attr]);
  return der.encodeSequence([rdn]);
}

/**
 * The AlgorithmIdentifier for ecdsa-with-SHA256 (no parameters).
 * @returns {Buffer}
 */
function ecdsaWithSHA256AlgId(): Buffer {
  return der.encodeSequence([der.encodeOID(OID.ecdsaWithSHA256)]);
}

/**
 * Generate a self-signed ECDSA P-256 certificate.
 *
 * @param {GenerateSelfSignedOptions} [options]
 * @returns {SelfSignedCertificate}
 */
export function generateSelfSigned(
  options: GenerateSelfSignedOptions = {}
): SelfSignedCertificate {
  const commonName =
    options.commonName || `WebRTC-${crypto.randomBytes(8).toString('hex')}`;
  const days = options.days || 30;

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });

  // Node exports a complete SubjectPublicKeyInfo in DER — reuse verbatim.
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;

  // Validity. Start one day in the past to tolerate clock skew between peers.
  const notBefore =
    options.notBefore || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + days * 24 * 60 * 60 * 1000);

  // Serial number: positive 20-byte random (high bit cleared via encoder).
  const serial = crypto.randomBytes(20);
  serial[0]! &= 0x7f;
  if (serial[0] === 0) serial[0] = 0x01;

  const name = buildName(commonName);

  // TBSCertificate (X.509 v3).
  const tbs = der.encodeSequence([
    der.encodeExplicit(0, der.encodeInteger(2)), // version v3 (value 2)
    der.encodeIntegerFromBuffer(serial), // serialNumber
    ecdsaWithSHA256AlgId(), // signature algorithm
    name, // issuer (== subject, self-signed)
    der.encodeSequence([der.encodeTime(notBefore), der.encodeTime(notAfter)]),
    name, // subject
    spki, // subjectPublicKeyInfo
  ]);

  // Sign the TBS. Node returns a DER ECDSA-Sig-Value (SEQUENCE { r, s }).
  const signature = crypto.sign('sha256', tbs, privateKey);

  const certDer = der.encodeSequence([
    tbs,
    ecdsaWithSHA256AlgId(),
    der.encodeBitString(signature),
  ]);

  return { certDer, privateKey, publicKey, notBefore, notAfter };
}

/**
 * Compute the certificate fingerprint as used in SDP a=fingerprint (RFC 8122):
 * hash over the DER-encoded certificate, uppercase hex, colon-separated.
 *
 * @param {Buffer} certDer
 * @param {string} [algorithm='sha-256'] - 'sha-256' | 'sha-384' | 'sha-512'
 * @returns {string}
 */
export function fingerprint(
  certDer: Buffer,
  algorithm: string = 'sha-256'
): string {
  const nodeAlgo = algorithm.replace('-', '').toLowerCase(); // sha-256 -> sha256
  const digest = crypto
    .createHash(nodeAlgo)
    .update(certDer)
    .digest('hex')
    .toUpperCase();
  return digest.match(/.{2}/g)!.join(':');
}
