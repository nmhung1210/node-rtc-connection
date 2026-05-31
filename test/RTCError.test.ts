/**
 * Test suite for RTCError
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import RTCError from '../src/foundation/RTCError';

describe('RTCError', () => {
  describe('construction', () => {
    it('should create error with minimal arguments', () => {
      const error = new RTCError({}, 'Test error');
      assert.strictEqual(error.name, 'RTCError');
      assert.strictEqual(error.message, 'Test error');
      assert.strictEqual(error.errorDetail, 'none');
      assert.ok(error instanceof Error);
      assert.ok(error instanceof RTCError);
    });

    it('should create error with errorDetail', () => {
      const error = new RTCError({ errorDetail: 'dtls-failure' }, 'DTLS failed');
      assert.strictEqual(error.errorDetail, 'dtls-failure');
      assert.strictEqual(error.message, 'DTLS failed');
    });

    it('should create error with optional fields', () => {
      const error = new RTCError({
        errorDetail: 'sdp-syntax-error',
        sdpLineNumber: 10,
        httpRequestStatusCode: 404,
        sctpCauseCode: 1,
        receivedAlert: 20,
        sentAlert: 30
      }, 'SDP parse error');

      assert.strictEqual(error.errorDetail, 'sdp-syntax-error');
      assert.strictEqual(error.sdpLineNumber, 10);
      assert.strictEqual(error.httpRequestStatusCode, 404);
      assert.strictEqual(error.sctpCauseCode, 1);
      assert.strictEqual(error.receivedAlert, 20);
      assert.strictEqual(error.sentAlert, 30);
    });

    it('should have stack trace', () => {
      const error = new RTCError({}, 'Test');
      assert.ok(error.stack);
      assert.ok(error.stack!.includes('RTCError'));
    });
  });

  describe('validation', () => {
    it('should throw if errorDetail is not a string', () => {
      assert.throws(() => new RTCError({ errorDetail: 123 as any }), TypeError);
    });

    it('should throw if sdpLineNumber is not an integer', () => {
      assert.throws(() => new RTCError({ sdpLineNumber: 1.5 }), TypeError);
    });

    it('should throw if receivedAlert is negative', () => {
      assert.throws(() => new RTCError({ receivedAlert: -1 }), TypeError);
    });

    it('should throw if sentAlert is negative', () => {
      assert.throws(() => new RTCError({ sentAlert: -1 }), TypeError);
    });

    it('should accept null values for optional fields', () => {
      const error = new RTCError({
        sdpLineNumber: null,
        receivedAlert: undefined
      }, 'Test');

      assert.strictEqual(error.sdpLineNumber, null);
      assert.strictEqual(error.receivedAlert, null);
    });
  });

  describe('getters', () => {
    it('should return null for unset optional fields', () => {
      const error = new RTCError({}, 'Test');
      assert.strictEqual(error.sdpLineNumber, null);
      assert.strictEqual(error.httpRequestStatusCode, null);
      assert.strictEqual(error.sctpCauseCode, null);
      assert.strictEqual(error.receivedAlert, null);
      assert.strictEqual(error.sentAlert, null);
    });

    it('should return set values', () => {
      const error = new RTCError({
        sdpLineNumber: 42,
        sctpCauseCode: 99
      }, 'Test');

      assert.strictEqual(error.sdpLineNumber, 42);
      assert.strictEqual(error.sctpCauseCode, 99);
    });
  });

  describe('toJSON', () => {
    it('should serialize minimal error', () => {
      const error = new RTCError({}, 'Test message');
      const json = error.toJSON();

      assert.deepStrictEqual(json, {
        name: 'RTCError',
        message: 'Test message',
        errorDetail: 'none'
      });
    });

    it('should serialize complete error', () => {
      const error = new RTCError({
        errorDetail: 'data-channel-failure',
        sdpLineNumber: 5,
        httpRequestStatusCode: 500,
        sctpCauseCode: 3,
        receivedAlert: 10,
        sentAlert: 20
      }, 'Data channel error');

      const json = error.toJSON();

      assert.deepStrictEqual(json, {
        name: 'RTCError',
        message: 'Data channel error',
        errorDetail: 'data-channel-failure',
        sdpLineNumber: 5,
        httpRequestStatusCode: 500,
        sctpCauseCode: 3,
        receivedAlert: 10,
        sentAlert: 20
      });
    });

    it('should omit null fields from JSON', () => {
      const error = new RTCError({
        errorDetail: 'dtls-failure',
        sdpLineNumber: 1
      }, 'Test');

      const json = error.toJSON();
      assert.ok(!('httpRequestStatusCode' in json));
      assert.ok(!('sctpCauseCode' in json));
    });
  });

  describe('static methods', () => {
    it('should create from native error', () => {
      const nativeError = {
        error_detail: 'sctp-failure',
        sctp_cause_code: 42,
        message: 'SCTP error occurred'
      };

      const error = RTCError.fromNative(nativeError);

      assert.strictEqual(error.errorDetail, 'sctp-failure');
      assert.strictEqual(error.sctpCauseCode, 42);
      assert.strictEqual(error.message, 'SCTP error occurred');
    });

    it('should handle native error with missing fields', () => {
      const nativeError = {
        message: 'Unknown error'
      };

      const error = RTCError.fromNative(nativeError);
      assert.strictEqual(error.errorDetail, 'none');
      assert.strictEqual(error.message, 'Unknown error');
    });
  });

  describe('DetailType constant', () => {
    it('should expose error detail types', () => {
      assert.strictEqual(RTCError.DetailType.NONE, 'none');
      assert.strictEqual(RTCError.DetailType.DATA_CHANNEL_FAILURE, 'data-channel-failure');
      assert.strictEqual(RTCError.DetailType.DTLS_FAILURE, 'dtls-failure');
      assert.strictEqual(RTCError.DetailType.FINGERPRINT_FAILURE, 'fingerprint-failure');
      assert.strictEqual(RTCError.DetailType.SCTP_FAILURE, 'sctp-failure');
      assert.strictEqual(RTCError.DetailType.SDP_SYNTAX_ERROR, 'sdp-syntax-error');
    });

    it('should be frozen', () => {
      'use strict';
      assert.throws(() => {
        (RTCError.DetailType as any).NONE = 'modified';
      }, TypeError);
    });
  });
});
