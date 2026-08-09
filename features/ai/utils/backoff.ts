// RD-AI-01 · Retry backoff.
//
// PURE and DETERMINISTIC. No SDK, no clock of its own — `now` is always passed in, so a
// schedule is reproducible in a test instead of being whatever the machine felt like.
//
// No random jitter. Jitter exists to de-synchronise a thundering herd of clients hitting one
// server; this queue is drained by ONE leased dispatcher at a time, so the herd never forms,
// and a non-deterministic delay would only make an incident harder to reason about.

export interface BackoffPolicy {
  /** Delay before the FIRST retry, ms. */
  baseMs: number
  /** Multiplier per subsequent attempt. */
  factor: number
  /** Ceiling, ms — a long outage must not push a job a week into the future. */
  maxMs:  number
}

/**
 * 30s → 2m → 8m → 32m, capped at 30 minutes.
 *
 * Tuned for the failure that actually happens: a provider rate-limit or a transient 5xx.
 * Both clear in minutes, so the first retry is fast enough to recover a single hiccup
 * without a human, and the cap keeps a long outage draining steadily once it ends.
 */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 30_000,
  factor: 4,
  maxMs:  30 * 60_000,
}

/**
 * Delay after `attempt` failed attempts.
 *
 * `attempt` is 1-based: 1 = the first attempt just failed. Anything below 1 is treated as 1
 * rather than throwing — a corrupt counter must not stop a job being rescheduled.
 */
export function backoffMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const n = Math.max(1, Math.floor(attempt))
  const raw = policy.baseMs * Math.pow(policy.factor, n - 1)
  // `raw` can overflow to Infinity for an absurd attempt count; Math.min handles that.
  return Math.min(Math.round(raw), policy.maxMs)
}

/** Epoch ms at which a job that has failed `attempt` times becomes claimable again. */
export function nextAttemptAt(
  now: number, attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF,
): number {
  return now + backoffMs(attempt, policy)
}

/**
 * How long a job may hold its lease.
 *
 * Must exceed the slowest realistic provider call, or a healthy worker's lease expires
 * mid-flight and a second worker duplicates the request. Two minutes is generous for a
 * single-image inference and still recovers a dead worker quickly.
 */
export const DEFAULT_LEASE_MS = 120_000

/** Attempts allowed per job before it is failed for good. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Clamps a caller-supplied attempt budget into a sane range. */
export function clampMaxAttempts(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_MAX_ATTEMPTS
  return Math.min(Math.max(1, n), 10)
}
