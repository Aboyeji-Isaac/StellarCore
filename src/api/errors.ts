import { Response } from 'express';

/**
 * Machine-readable error codes for public API responses
 */
export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE'
}

/**
 * Standard error envelope for all public API errors
 */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Helper to send standardized error responses
 * @param res Express response object
 * @param status HTTP status code
 * @param code Machine-readable error code
 * @param message Human-readable error message
 * @param details Optional additional context (must be sanitized)
 */
export function sendErrorResponse(
  res: Response,
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>
): void {
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      ...(details && { details })
    }
  };
  res.status(status).json(body);
}

/**
 * Helper to create validation error responses
 */
export function validationError(
  res: Response,
  message: string,
  details?: Record<string, unknown>
): void {
  sendErrorResponse(res, 400, ErrorCode.VALIDATION_ERROR, message, details);
}

/**
 * Helper to create not found error responses
 */
export function notFoundError(
  res: Response,
  message: string = 'Resource not found',
  details?: Record<string, unknown>
): void {
  sendErrorResponse(res, 404, ErrorCode.NOT_FOUND, message, details);
}

/**
 * Helper to create rate limit error responses
 */
export function rateLimitError(
  res: Response,
  message: string = 'Too many requests',
  details?: Record<string, unknown>
): void {
  sendErrorResponse(res, 429, ErrorCode.RATE_LIMITED, message, details);
}

/**
 * Helper to create internal error responses
 * Note: Never pass raw errors or sensitive information
 */
export function internalError(
  res: Response,
  message: string = 'Internal server error',
  details?: Record<string, unknown>
): void {
  sendErrorResponse(res, 500, ErrorCode.INTERNAL_ERROR, message, details);
}

/**
 * Helper to create service unavailable error responses
 */
export function serviceUnavailableError(
  res: Response,
  message: string = 'Service temporarily unavailable',
  details?: Record<string, unknown>
): void {
  sendErrorResponse(res, 503, ErrorCode.SERVICE_UNAVAILABLE, message, details);
}

/**
 * Safe error handler for unknown exceptions
 * Logs full error internally but returns sanitized response
 */
export function handleUnknownError(
  res: Response,
  error: unknown,
  logger: (error: unknown) => void
): void {
  logger(error);
  internalError(res);
}
