// RD-AI-01 · AI queue — the state machine.
//
// PURE. No SDK, no DOM, no I/O. Every rule about what a job may do next lives here so it can
// be proven by test rather than by watching a queue drain.
//
//   queued ──claim──▶ running ──succeed──▶ completed        (terminal)
//     │                  │
//     │                  ├──scheduleRetry──▶ retry ──claim──▶ running
//     │                  ├──expireLease────▶ retry
//     │                  └──fail───────────▶ failed ──requeue──▶ queued
//     │
//     └──cancel──▶ cancelled                                 (terminal)
//
// `completed` and `cancelled` are terminal. `failed` is NOT terminal — an organizer may
// requeue it once the cause is fixed (a provider key, a quota). That is a deliberate human
// action; the pipeline never requeues a failed job on its own, or a permanently-broken image
// would be retried forever.

import type { AIJobStatus } from '@/features/ai/types'

export type AIQueueAction =
  /** A dispatcher picked the job up. */
  | 'claim'
  /** The provider returned a result. */
  | 'succeed'
  /** Failed with attempts remaining → wait out a backoff. */
  | 'scheduleRetry'
  /** Failed for good (no attempts left, or a non-retryable error). */
  | 'fail'
  /** The worker died holding a lease; the job is recoverable. */
  | 'expireLease'
  /** An organizer (or a cascading event delete) stopped the job. */
  | 'cancel'
  /** An organizer put a failed job back in line. */
  | 'requeue'

/** Legal transitions. Anything absent is refused — the machine is closed, not permissive. */
const TRANSITIONS: Readonly<Record<AIJobStatus, Partial<Record<AIQueueAction, AIJobStatus>>>> = {
  queued: {
    claim:  'running',
    cancel: 'cancelled',
    // A job can be failed before it ever runs — e.g. its asset was deleted underneath it.
    fail:   'failed',
  },
  running: {
    succeed:       'completed',
    scheduleRetry: 'retry',
    fail:          'failed',
    expireLease:   'retry',
    cancel:        'cancelled',
  },
  retry: {
    claim:  'running',
    cancel: 'cancelled',
    fail:   'failed',
  },
  failed: {
    requeue: 'queued',
    cancel:  'cancelled',
  },
  completed: {},
  cancelled: {},
}

export function canTransition(from: AIJobStatus, action: AIQueueAction): boolean {
  return TRANSITIONS[from][action] !== undefined
}

/** The next status, or null when the action is not legal from here. */
export function nextStatus(from: AIJobStatus, action: AIQueueAction): AIJobStatus | null {
  return TRANSITIONS[from][action] ?? null
}

export function isTerminal(status: AIJobStatus): boolean {
  return status === 'completed' || status === 'cancelled'
}

/** A dispatcher may pick this up (subject to `nextAttemptAt` for `retry`). */
export function isClaimable(status: AIJobStatus): boolean {
  return status === 'queued' || status === 'retry'
}

/** Cancellation is allowed right up to the terminal states. */
export function isCancellable(status: AIJobStatus): boolean {
  return canTransition(status, 'cancel')
}

// ─── Failure policy ───────────────────────────────────────────────────────────

/**
 * What a failed attempt turns into.
 *
 * `attempt` is the number of attempts ALREADY MADE, including the one that just failed.
 * A non-retryable error ends the job immediately regardless of budget — retrying a rejected
 * image or a malformed request only wastes provider quota.
 */
export function decideFailureAction(params: {
  attempt:     number
  maxAttempts: number
  retryable:   boolean
}): Extract<AIQueueAction, 'scheduleRetry' | 'fail'> {
  if (!params.retryable) return 'fail'
  return params.attempt < params.maxAttempts ? 'scheduleRetry' : 'fail'
}

/** Attempts still available after `attempt` tries. Never negative. */
export function attemptsRemaining(attempt: number, maxAttempts: number): number {
  return Math.max(0, maxAttempts - attempt)
}

// ─── Claim eligibility ────────────────────────────────────────────────────────

/**
 * Whether a dispatcher may take this job right now.
 *
 * Three gates, all of which must hold: the status is claimable, any backoff has elapsed, and
 * no other worker holds an unexpired lease. The lease check is what makes a second
 * dispatcher (a cron tick overlapping a manual run) cheap and safe rather than a double-spend
 * of provider quota.
 */
export function isDue(params: {
  status:        AIJobStatus
  nextAttemptAt: number | null
  lockedUntilMs: number | null
  now:           number
}): boolean {
  if (!isClaimable(params.status)) return false
  if (params.lockedUntilMs !== null && params.lockedUntilMs > params.now) return false
  if (params.status === 'retry' && params.nextAttemptAt !== null && params.nextAttemptAt > params.now) {
    return false
  }
  return true
}
