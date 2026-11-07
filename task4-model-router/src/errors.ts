/**
 * The ONE error shape clients ever see:
 *   { "error": { "code": "...", "message": "...", "request_id": "...", "retry_after_ms"?: n } }
 * No stack traces, hostnames, provider names/URLs or upstream bodies. Those go
 * to stderr under the same request_id.
 */
export type PublicCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "INTERNAL";

const STATUS: Record<PublicCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class GatewayError extends Error {
  readonly status: number;
  constructor(
    readonly code: PublicCode,
    message: string,
    readonly opts: { retryAfterMs?: number; cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.status = STATUS[code];
  }

  toBody(requestId: string): { error: { code: PublicCode; message: string; request_id: string; retry_after_ms?: number } } {
    const error: { code: PublicCode; message: string; request_id: string; retry_after_ms?: number } = {
      code: this.code,
      message: this.message,
      request_id: requestId,
    };
    if (this.opts.retryAfterMs !== undefined) error.retry_after_ms = this.opts.retryAfterMs;
    return { error };
  }
}
