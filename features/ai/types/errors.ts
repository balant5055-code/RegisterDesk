// RD-AI-01 · AI pipeline errors.
//
// PURE. No SDK, no I/O.
//
// Every failure the pipeline can produce is one of these codes, so a caller's handling is
// identical no matter which provider ran — exactly the discipline platform-storage uses
// (`StorageError`). A provider MUST translate its vendor error into one of these; a raw
// vendor error escaping the provider is a bug in that provider.

export type AIErrorCode =
  /** No provider is registered, or none supports the requested kind. */
  | 'NO_PROVIDER'
  /** A provider exists but is missing configuration (keys, endpoint). */
  | 'NOT_CONFIGURED'
  /** The kind is malformed, or the provider refuses it. */
  | 'UNSUPPORTED_KIND'
  /** Caller-supplied data is wrong. Never retryable. */
  | 'INVALID_INPUT'
  /** The subject (asset, job, gallery) does not exist or is not visible to this tenant. */
  | 'NOT_FOUND'
  /** The provider rejected the request in a way that will not improve on retry. */
  | 'PROVIDER_REJECTED'
  /** The provider failed in a way that might succeed later. */
  | 'PROVIDER_ERROR'
  /** Throttled by the provider. Retryable, and the reason backoff exists. */
  | 'RATE_LIMITED'
  /** The attempt exceeded its time budget. Retryable. */
  | 'TIMEOUT'
  /** The job was cancelled while running. */
  | 'CANCELLED'
  /** A transition the state machine refuses. */
  | 'INVALID_STATE'

/**
 * Codes worth another attempt.
 *
 * Conservative on purpose: retrying a deterministic failure burns a provider quota and
 * delays the honest "this will never work" the organizer needs to see.
 */
const RETRYABLE: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'PROVIDER_ERROR', 'RATE_LIMITED', 'TIMEOUT',
])

export function isRetryableCode(code: AIErrorCode): boolean {
  return RETRYABLE.has(code)
}

export class AIError extends Error {
  readonly code: AIErrorCode
  /** Whether the pipeline should schedule another attempt. */
  readonly retryable: boolean

  constructor(code: AIErrorCode, message: string, options?: { retryable?: boolean }) {
    super(message)
    this.name      = 'AIError'
    this.code      = code
    this.retryable = options?.retryable ?? isRetryableCode(code)
  }
}

export function isAIError(e: unknown): e is AIError {
  return e instanceof AIError
}

/** HTTP status for an error surfaced by a route. */
export function aiErrorStatus(code: AIErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
    case 'UNSUPPORTED_KIND':  return 400
    case 'NOT_FOUND':         return 404
    case 'INVALID_STATE':
    case 'CANCELLED':         return 409
    case 'NO_PROVIDER':
    case 'NOT_CONFIGURED':    return 503
    case 'RATE_LIMITED':      return 429
    case 'TIMEOUT':           return 504
    case 'PROVIDER_REJECTED': return 422
    case 'PROVIDER_ERROR':    return 502
  }
}

/**
 * Normalises anything thrown into an AIError.
 *
 * The message is TRUNCATED and carries no stack: a job document is read by an organizer,
 * and a provider's raw error body can echo request content back.
 */
export function toAIError(e: unknown, fallback: AIErrorCode = 'PROVIDER_ERROR'): AIError {
  if (isAIError(e)) return e
  const message = e instanceof Error ? e.message : String(e)
  return new AIError(fallback, message.slice(0, 300))
}
