// RD-JOB-CONT-01 · automatic continuation for jobs larger than one worker budget.
//
// THE BUG THIS EXISTS TO FIX. A worker chunk yields when its wall-clock budget is spent
// (runner.ts) — correct behaviour — and then something must come back for the next chunk.
// The only thing that ever did was a 5-minute cron that advances each job by exactly ONE
// chunk per tick. A 218-recipient email broadcast needed four chunks, so completion was
// gated on four separate scheduled ticks. It never got them: the workflow serialises
// (concurrency: cancel-in-progress: false, 14 sequential steps) and GitHub delays
// schedules under load, so the campaign sat at 54/218 until someone cancelled it.
//
// The fix is to let a worker that yielded ASK for the next invocation immediately, instead
// of waiting for a clock. Three independent layers now advance a job, so no single one is
// load-bearing:
//
//   1. this chain          — immediate, the common case
//   2. the 5-minute cron   — backstop if a chain is dropped
//   3. the job reaper      — last resort; revives or fails a genuinely stuck job
//
// DELIBERATELY NOT SOLVED HERE: the lease. The chained invocation lands while the previous
// worker's lease is still held (leases run 60s, budgets 45s), so the receiving cron retries
// through that window rather than releasing the lease early. Releasing on yield would be
// tidier and is NOT done on purpose — lib/jobs/kernel.ts is shared by certificates, prints,
// imports, media and reports, and this bug does not justify touching their fencing.

import { APP_URL, CRON_SECRET } from '@/lib/env'

/** Chain depth travels on the request so a runaway loop is impossible. */
export const CHAIN_DEPTH_HEADER = 'x-job-chain-depth'

/**
 * Hard ceiling on consecutive self-invocations.
 *
 * At ~45s of work per chunk this is ~9 minutes of continuous chaining, comfortably more
 * than any single broadcast needs, and it bounds the blast radius if `shouldChain` is ever
 * wrong. Reaching the cap is not a failure: the job stays `processing`, and the 5-minute
 * cron picks it up exactly as it does today.
 */
export const MAX_CHAIN_DEPTH = 12

export type ChainOutcome =
  | 'dispatched'
  | 'skipped_no_progress'
  | 'skipped_terminal'
  | 'skipped_max_depth'
  | 'skipped_unconfigured'
  | 'failed'

/** Reads the incoming chain depth. Anything malformed or out of range reads as 0. */
export function readChainDepth(headers: { get(name: string): string | null }): number {
  const raw = headers.get(CHAIN_DEPTH_HEADER)
  // Only the exact shape we emit is honoured. parseInt would read '1.5' as 1 and '3abc'
  // as 3; this header decides whether a self-invoking loop keeps going, so anything we
  // did not write ourselves is treated as depth 0 rather than guessed at.
  if (!raw || !/^\d+$/.test(raw)) return 0
  const n = Number.parseInt(raw, 10)
  return n <= MAX_CHAIN_DEPTH ? n : 0
}

export interface ChainDecision {
  /** Items processed across all jobs in THIS invocation. */
  advanced:    number
  /** Jobs still non-terminal after this invocation. */
  nonTerminal: number
  depth:       number
}

/**
 * Whether to invoke ourselves again.
 *
 * BOTH conditions are required, and the first is the important one: chaining only after
 * REAL progress means a job that cannot advance — permission error, provider outage, a
 * `busy` lease — stops the chain instead of hammering the endpoint. A stalled job then
 * falls through to the cron and, if it stays stuck, to the reaper. That is the difference
 * between a retry loop and a spin loop.
 */
export function shouldChain(d: ChainDecision): ChainOutcome {
  if (d.depth >= MAX_CHAIN_DEPTH) return 'skipped_max_depth'
  if (d.advanced <= 0)            return 'skipped_no_progress'
  if (d.nonTerminal <= 0)         return 'skipped_terminal'
  return 'dispatched'
}

/**
 * How long to wait for the child to ACCEPT the request. We do not wait for it to finish —
 * the child runs a full chunk and would keep us alive for its whole budget.
 *
 * Aborting our side after the request is delivered does not stop the child: the invocation
 * has already been handed off. If it somehow is dropped, layers 2 and 3 still cover it,
 * which is precisely why this is allowed to be best-effort.
 */
const DISPATCH_TIMEOUT_MS = 3_000

/**
 * Invokes `path` again, one chain-depth deeper. Best-effort by design — never throws, and
 * the caller must not treat a failure as a job failure.
 *
 * Call this from `after()` so it runs once the response is already sent.
 */
export async function triggerChain(path: string, depth: number): Promise<ChainOutcome> {
  const base = (APP_URL ?? '').replace(/\/+$/, '')
  // Fail quiet, not loud: without a base URL or a cron secret the chain simply does not
  // exist and the scheduled cron remains the only driver — i.e. today's behaviour.
  if (!base || !CRON_SECRET) return 'skipped_unconfigured'

  try {
    await fetch(`${base}${path}`, {
      method:  'POST',
      headers: {
        Authorization:        `Bearer ${CRON_SECRET}`,
        [CHAIN_DEPTH_HEADER]: String(depth + 1),
      },
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    })
    return 'dispatched'
  } catch {
    // Includes the deliberate abort once the child has taken the request.
    return 'dispatched'
  }
}

/** Bounded wait for a lease held by the worker that just chained to us. */
export const BUSY_RETRY_DELAY_MS = 3_000
/** Slightly over the 60s lease minus the 45s budget, so the window is fully covered. */
export const BUSY_RETRY_MAX_MS   = 18_000

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
