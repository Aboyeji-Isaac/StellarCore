import { Request, Response, NextFunction } from 'express';
import { handleUnknownError, ErrorCode } from '../api/errors';
import { logger } from '../utils/logger';

/**
 * Global error handler middleware
 * Catches all unhandled errors and returns standardized responses
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If response has already been sent, delegate to next
  if (res.headersSent) {
    return next(error);
  }

  // Log the full error internally
  logger.error('Unhandled error', {
    error,
    path: req.path,
    method: req.method,
    headers: req.headers,
    body: req.body,
    query: req.query,
    params: req.params
  });

  // Return sanitized error response
  handleUnknownError(res, error, (err) => {
    logger.error('Error in errorHandler', { err });
  });
}

/**
 * 404 handler for undefined routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  if (!res.headersSent) {
    res.status(404).json({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: 'Endpoint not found'
      }
    });
  }
}
