export type ErrorCode =
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'FORBIDDEN_ROLE'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'OKTA_INTERNAL'
  | 'NETWORK'
  | 'VALIDATION'
  | 'CONFIRMATION_REQUIRED'
  | 'USER_DECLINED'
  | 'STATE_CHANGED'
  | 'OAUTH_FAILED'
  | 'SCOPE_INSUFFICIENT'
  | 'ADMIN_ROLE_MISSING'
  | 'CLIENT_NOT_FOUND'
  | 'KEY_INVALID';

export interface ToolError {
  code: ErrorCode;
  message: string;
  oktaRequestId?: string;
  details?: unknown;
}

export type Either<E, T> = { ok: false; error: E } | { ok: true; data: T };

const REDACT_PATTERN = /authorization|token|ssws|private.?key|secret|client_assertion/i;

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (REDACT_PATTERN.test(value)) return '[REDACTED]';
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_PATTERN.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

interface OktaApiError {
  status?: number;
  message?: string;
  errorCode?: string;
  errorSummary?: string;
  headers?: Record<string, string>;
}

export function normalizeOktaError(err: unknown): ToolError {
  const e = err as OktaApiError;
  const oktaRequestId = e.headers?.['x-okta-request-id'];
  const message = e.errorSummary ?? e.message ?? String(err);

  const status = e.status ?? 0;

  if (status === 404) return { code: 'NOT_FOUND', message, oktaRequestId };
  if (status === 401) return { code: 'UNAUTHORIZED', message, oktaRequestId };
  if (status === 403) {
    const is403Role = message.toLowerCase().includes('admin') || message.toLowerCase().includes('role');
    return { code: is403Role ? 'FORBIDDEN_ROLE' : 'FORBIDDEN', message, oktaRequestId };
  }
  if (status === 429) return { code: 'RATE_LIMITED', message, oktaRequestId };
  if (status === 400) return { code: 'BAD_REQUEST', message, oktaRequestId };
  if (status >= 500) return { code: 'OKTA_INTERNAL', message, oktaRequestId };

  const msg = String(err instanceof Error ? err.message : err);
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
    return { code: 'NETWORK', message: msg };
  }

  return { code: 'BAD_REQUEST', message, oktaRequestId };
}

export async function safeOktaCall<T>(fn: () => Promise<T>): Promise<Either<ToolError, T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: normalizeOktaError(err) };
  }
}
