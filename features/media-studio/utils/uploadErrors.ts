// RD-MEDIA-03 · Upload failure messages.
//
// PURE. No SDK, no DOM, no I/O.
//
// An upload can fail in half a dozen ways that need completely different responses from the
// organizer — retry, wait, fix the event, call support — and before this they all read
// "Upload failed." This turns a failure into the one sentence that says what to do.
//
// Kept out of the queue hook so the mapping is unit-testable, and so a new failure mode is
// added in one place rather than wherever it happened to be caught.

/**
 * MC-10.5 · A server refusal, with its structure intact.
 *
 * The queue used to collapse every non-OK response into `new Error(body.error)`, throwing
 * the HTTP status and the response body away. That was survivable while every failure was
 * classified by prose — but a 402 carries NUMBERS the organizer needs (how many credits are
 * required, how many they have), and no amount of string matching recovers them.
 *
 * Thrown by the queue's fetch sites; read by `classifyUploadError` before it falls back to
 * matching text.
 */
export class UploadRequestError extends Error {
  readonly status: number
  /** The server's machine-readable code, e.g. `INSUFFICIENT_CREDITS`. Null when absent. */
  readonly code:   string | null
  /** The parsed response body, for codes that carry detail. */
  readonly detail: Record<string, unknown> | null

  constructor(message: string, status: number, code: string | null, detail: Record<string, unknown> | null) {
    super(message)
    this.name   = 'UploadRequestError'
    this.status = status
    this.code   = code
    this.detail = detail
  }
}

export type UploadFailureKind =
  /** The network dropped, or the browser could not reach storage at all. */
  | 'network'
  /** Object storage did not answer in time. */
  | 'timeout'
  /** The signed URL had already expired by the time the PUT ran. */
  | 'expired'
  /** The organizer's session expired mid-upload. */
  | 'auth'
  /** The server refused the key — see the storage path note in RD-MEDIA-03. */
  | 'storage_path'
  /** Object storage is not configured for this deployment. */
  | 'not_configured'
  /** The file itself is not acceptable — type, size, or a corrupt image. */
  | 'file_rejected'
  /** The gallery or album vanished (deleted in another tab). */
  | 'missing_target'
  /** Storage rate-limited or briefly failed. */
  | 'provider'
  /**
   * MC-10.5 · The organizer has run out of Media Credits.
   *
   * Its own kind rather than a `file_rejected` 4xx, because it is the one upload failure
   * where retrying is GUARANTEED to fail and where the organizer can fix it themselves.
   */
  | 'insufficient_credits'
  /** Anything unclassified. */
  | 'unknown'

export interface UploadFailure {
  kind:   UploadFailureKind
  /** One sentence naming the cause. Shown as the failure reason. */
  reason: string
  /** What the organizer can do about it. */
  action: string
  /** Whether retrying this item is worth offering. */
  retryable: boolean
  /**
   * MC-10.5 · Present only for `insufficient_credits`.
   *
   * Straight from the server's 402 — never recomputed here. A shortfall the client worked out
   * for itself would be a second source of truth for the number the organizer is about to
   * spend money on.
   */
  credits?: { required: number; available: number; shortfall: number }
}

const FAILURES: Readonly<Record<UploadFailureKind, Omit<UploadFailure, 'kind'>>> = {
  network: {
    reason: 'The connection to storage dropped.',
    action: 'Check your internet connection, then retry — photos already uploaded are kept.',
    retryable: true,
  },
  timeout: {
    reason: 'Storage did not respond in time.',
    action: 'This is usually temporary. Retry — anything already uploaded is not re-sent.',
    retryable: true,
  },
  expired: {
    reason: 'The upload link expired before the file finished.',
    action: 'Retry to get a fresh link. Very large photos on a slow connection hit this most.',
    retryable: true,
  },
  auth: {
    reason: 'Your session expired while uploading.',
    action: 'Sign in again, then retry. Your queue is still here.',
    retryable: true,
  },
  storage_path: {
    reason: 'The storage location for this event was rejected.',
    action: 'This is a configuration problem, not something you can fix by retrying. Please contact support with the event name.',
    retryable: false,
  },
  not_configured: {
    reason: 'This deployment has no media storage configured.',
    action: 'Photos cannot be uploaded until object storage is set up. Contact support.',
    retryable: false,
  },
  file_rejected: {
    reason: 'This file was refused.',
    action: 'It may be corrupt, or larger than the limit. Remove it and upload the rest.',
    retryable: false,
  },
  missing_target: {
    reason: 'The gallery or album no longer exists.',
    action: 'It may have been deleted in another tab. Pick a gallery again and retry.',
    retryable: false,
  },
  provider: {
    reason: 'Storage rejected the upload.',
    action: 'Usually a brief rate limit. Wait a moment and retry.',
    retryable: true,
  },
  insufficient_credits: {
    reason: 'Not enough Media Credits.',
    action: 'Buy credits to continue — photos already uploaded are kept.',
    retryable: false,
  },
  unknown: {
    reason: 'The upload did not complete.',
    action: 'Retry. If it keeps happening, note the photo name and contact support.',
    retryable: true,
  },
}

/**
 * Classifies a thrown error.
 *
 * Matches on the SERVER'S OWN wording where it is distinctive, and on HTTP status otherwise.
 * Deliberately conservative: anything unrecognised is `unknown` and stays retryable, because
 * telling an organizer not to bother retrying is worse than letting them try once more.
 */
export function classifyUploadError(error: unknown): UploadFailure {
  // ── MC-10.5 · structured first, prose second ────────────────────────────────
  // A server code is authoritative in a way a sentence never is. Matching text for this one
  // would also be actively wrong: the 402's message contains the word "credits" and nothing
  // else distinctive, and the numbers it carries cannot be recovered from a string at all.
  if (error instanceof UploadRequestError && error.code === 'INSUFFICIENT_CREDITS') {
    const required  = num(error.detail?.required)
    const available = num(error.detail?.available)
    return {
      kind: 'insufficient_credits',
      ...FAILURES.insufficient_credits,
      credits: {
        required, available,
        // Never negative: a 402 with available >= required would mean the balance moved
        // between the server's check and its response, and "buy -5 credits" helps nobody.
        shortfall: Math.max(0, required - available),
      },
    }
  }

  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw.toLowerCase()

  const kind: UploadFailureKind =
    // Checked before the generic network match: an abort is a timeout, not a dropped link.
    message.includes('timeout') || message.includes('timed out') || message.includes('aborted')
      ? 'timeout'
    // Statuses are matched with \b rather than a leading space: the browser layer formats
    // them as "Upload failed (503)", so a space-anchored pattern would never fire.
    : message.includes('session has expired') || message.includes('sign in') || /\b401\b/.test(message)
      ? 'auth'
    : message.includes('invalid event slug') || message.includes('storage path') || message.includes('unsafe storage key')
      ? 'storage_path'
    : message.includes('not configured') || message.includes('no object-storage')
      ? 'not_configured'
    : message.includes('gallery not found') || message.includes('album not found')
      ? 'missing_target'
    : message.includes('publish this event')
      ? 'storage_path'
    : /\b403\b/.test(message) || message.includes('expired') || message.includes('signature')
      ? 'expired'
    : /\b5\d\d\b/.test(message) || /\b429\b/.test(message) || message.includes('rate limit')
      ? 'provider'
    : /\b4\d\d\b/.test(message) || message.includes('unsupported') || message.includes('too large')
      ? 'file_rejected'
    : message.includes('failed to fetch') || message.includes('network') || message.includes('load failed')
      ? 'network'
    : 'unknown'

  return { kind, ...FAILURES[kind] }
}

/** `Storage did not respond in time. This is usually temporary. Retry…` */
export function formatUploadFailure(failure: UploadFailure): string {
  return `${failure.reason} ${failure.action}`
}

/** Groups a queue's failures so the UI reports causes rather than a count. */
export function summariseFailures(
  failures: readonly UploadFailure[],
): (Omit<UploadFailure, "kind"> & { kind: UploadFailureKind; count: number })[] {
  const byKind = new Map<UploadFailureKind, { failure: UploadFailure; count: number }>()
  for (const f of failures) {
    const seen = byKind.get(f.kind)
    if (!seen) { byKind.set(f.kind, { failure: f, count: 1 }); continue }
    seen.count += 1
    // MC-10.5 · keep the WORST shortfall. Each failed photo reports the wallet as it stood
    // when it failed, so the largest is the amount that actually clears the queue.
    if ((f.credits?.shortfall ?? 0) > (seen.failure.credits?.shortfall ?? 0)) seen.failure = f
  }
  return [...byKind.values()]
    // Most common first — that is the one worth acting on.
    .sort((a, b) => b.count - a.count)
    .map(({ failure, count }) => ({
      kind: failure.kind, reason: failure.reason, action: failure.action,
      retryable: failure.retryable, count,
      // MC-10.5 · carried through so the banner can state the shortfall.
      credits: failure.credits,
    }))
}

/** A stored number that cannot be trusted contributes 0 rather than NaN to the shortfall. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0
}

/** True when retrying the queue could plausibly help. */
export function hasRetryableFailure(failures: readonly UploadFailure[]): boolean {
  return failures.some(f => f.retryable)
}
