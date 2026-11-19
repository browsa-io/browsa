/** Error classes shared by the browser API client and the captcha client. */

export interface ErrorEnvelope {
  code?: string;
  error?: string;
  message?: string;
  request_id?: string;
}

export class BrowsaError extends Error {
  code?: string;
  requestId?: string;
  status?: number;
  body?: unknown;
  constructor(message: string, opts: { code?: string; requestId?: string; status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "BrowsaError";
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.status = opts.status;
    this.body = opts.body;
  }
}
/** @deprecated Renamed to BrowsaError. Kept as an alias for backwards compat; will be removed in a future major. */
export class APIError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "APIError"; } }
export class AuthError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "AuthError"; } }
export class RateLimitError extends BrowsaError {
  retryAfter?: number;
  constructor(msg: string, opts: ConstructorParameters<typeof BrowsaError>[1] & { retryAfter?: number } = {}) {
    super(msg, opts);
    this.name = "RateLimitError";
    this.retryAfter = opts.retryAfter;
  }
}
export class InvalidIDError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "InvalidIDError"; } }
export class NotFoundError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "NotFoundError"; } }
export class TimeoutError extends BrowsaError { constructor(...a: ConstructorParameters<typeof BrowsaError>) { super(...a); this.name = "TimeoutError"; } }
