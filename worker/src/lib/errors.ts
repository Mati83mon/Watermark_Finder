import type { ApiError } from '@wf/shared';

/** An error that maps directly onto an HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toJSON(requestId?: string): ApiError {
    return {
      error: this.code,
      message: this.message,
      ...(requestId ? { request_id: requestId } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Missing or invalid workspace token') =>
  new HttpError(401, 'unauthorized', message);

export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

export const payloadTooLarge = (message: string, details?: unknown) =>
  new HttpError(413, 'payload_too_large', message, details);

export const tooManyRequests = (message: string, retryAfterSeconds: number) =>
  new HttpError(429, 'rate_limited', message, { retry_after_seconds: retryAfterSeconds });

export const badGateway = (message: string, details?: unknown) =>
  new HttpError(502, 'engine_unavailable', message, details);

export const serverError = (message = 'Internal error') =>
  new HttpError(500, 'internal_error', message);
