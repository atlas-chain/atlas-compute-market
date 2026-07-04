/** Error format and code → HTTP status mapping (spec §13). */

export type ErrorCode =
  | "VALIDATION"
  | "SIG_MISMATCH"
  | "STALE_PAYLOAD"
  | "SEQ_REGRESSION"
  | "UNKNOWN_PROVIDER"
  | "UNKNOWN_OFFER"
  | "UNKNOWN_ATTESTATION"
  | "UNKNOWN_CHALLENGE"
  | "ATTESTATION_EXPIRED"
  | "ARCH_UNSUPPORTED"
  | "BENCH_FAILED"
  | "EXPIRED"
  | "EXPIRED_CURSOR"
  | "REVOKED"
  | "LIMIT_EXCEEDED"
  | "TERMS_TOO_LONG"
  | "RATE_LIMITED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  SIG_MISMATCH: 400,
  ARCH_UNSUPPORTED: 400,
  BENCH_FAILED: 400,
  EXPIRED: 400,
  REVOKED: 400,
  LIMIT_EXCEEDED: 400,
  TERMS_TOO_LONG: 400,
  UNKNOWN_PROVIDER: 404,
  UNKNOWN_OFFER: 404,
  UNKNOWN_ATTESTATION: 404,
  UNKNOWN_CHALLENGE: 404,
  SEQ_REGRESSION: 409,
  STALE_PAYLOAD: 409,
  EXPIRED_CURSOR: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }

  toResponse(): Response {
    return Response.json(
      { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } },
      { status: this.status },
    );
  }
}

export function err(code: ErrorCode, message: string, details?: Record<string, unknown>): ApiError {
  return new ApiError(code, message, details);
}
