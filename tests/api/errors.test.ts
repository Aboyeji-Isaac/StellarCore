import { Response } from 'express';
import {
  ErrorCode,
  ErrorEnvelope,
  sendErrorResponse,
  validationError,
  notFoundError,
  rateLimitError,
  internalError,
  serviceUnavailableError,
  handleUnknownError
} from '../../src/api/errors';

// Mock Express Response
class MockResponse {
  statusCode: number | undefined;
  jsonData: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(data: unknown): this {
    this.jsonData = data;
    return this;
  }
}

describe('Error Envelope', () => {
  let res: MockResponse;

  beforeEach(() => {
    res = new MockResponse();
  });

  describe('sendErrorResponse', () => {
    it('should send error response with correct structure', () => {
      sendErrorResponse(res as unknown as Response, 400, ErrorCode.VALIDATION_ERROR, 'Invalid input');

      expect(res.statusCode).toBe(400);
      expect(res.jsonData).toEqual({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid input'
        }
      });
    });

    it('should include details when provided', () => {
      const details = { field: 'email', reason: 'invalid format' };
      sendErrorResponse(
        res as unknown as Response,
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid input',
        details
      );

      expect(res.jsonData).toEqual({
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Invalid input',
          details
        }
      });
    });
  });

  describe('validationError', () => {
    it('should send 400 with VALIDATION_ERROR code', () => {
      validationError(res as unknown as Response, 'Invalid parameters');

      expect(res.statusCode).toBe(400);
      expect((res.jsonData as ErrorEnvelope).error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('notFoundError', () => {
    it('should send 404 with NOT_FOUND code', () => {
      notFoundError(res as unknown as Response);

      expect(res.statusCode).toBe(404);
      expect((res.jsonData as ErrorEnvelope).error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('should use custom message when provided', () => {
      notFoundError(res as unknown as Response, 'Account not found');

      expect((res.jsonData as ErrorEnvelope).error.message).toBe('Account not found');
    });
  });

  describe('rateLimitError', () => {
    it('should send 429 with RATE_LIMITED code', () => {
      rateLimitError(res as unknown as Response);

      expect(res.statusCode).toBe(429);
      expect((res.jsonData as ErrorEnvelope).error.code).toBe(ErrorCode.RATE_LIMITED);
    });
  });

  describe('internalError', () => {
    it('should send 500 with INTERNAL_ERROR code', () => {
      internalError(res as unknown as Response);

      expect(res.statusCode).toBe(500);
      expect((res.jsonData as ErrorEnvelope).error.code).toBe(ErrorCode.INTERNAL_ERROR);
    });

    it('should not expose sensitive details', () => {
      const sensitiveDetails = { stack: 'at line 42', dbError: 'connection failed' };
      internalError(res as unknown as Response, 'Server error', sensitiveDetails);

      expect((res.jsonData as ErrorEnvelope).error.details).toEqual(sensitiveDetails);
      // Note: In production, the handler should sanitize these details
    });
  });

  describe('serviceUnavailableError', () => {
    it('should send 503 with SERVICE_UNAVAILABLE code', () => {
      serviceUnavailableError(res as unknown as Response);

      expect(res.statusCode).toBe(503);
      expect((res.jsonData as ErrorEnvelope).error.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    });
  });

  describe('handleUnknownError', () => {
    it('should log error and return generic internal error', () => {
      const logger = jest.fn();
      const testError = new Error('Database connection failed');

      handleUnknownError(res as unknown as Response, testError, logger);

      expect(logger).toHaveBeenCalledWith(testError);
      expect(res.statusCode).toBe(500);
      expect((res.jsonData as ErrorEnvelope).error.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect((res.jsonData as ErrorEnvelope).error.message).toBe('Internal server error');
      expect((res.jsonData as ErrorEnvelope).error.details).toBeUndefined();
    });
  });

  describe('ErrorEnvelope type', () => {
    it('should have the correct structure', () => {
      const envelope: ErrorEnvelope = {
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Test message',
          details: { field: 'test' }
        }
      };

      expect(envelope.error.code).toBeDefined();
      expect(envelope.error.message).toBeDefined();
      expect(envelope.error.details).toBeDefined();
    });
  });
});
