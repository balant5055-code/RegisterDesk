// Generic job worker loop (ROE-1b).
//
// The reusable execution flow extracted VERBATIM from the certificate job
// processor (lib/certificates/jobs.ts `processJobChunk`): lease → load context →
// cursor-paged loop (fetch page → process items → commit) → terminal hook. It
// knows NOTHING about certificates, registrations, email, QR, or badges — every
// domain concern is supplied by the injected `JobStrategy`.
//
// One call processes one CHUNK (multiple committed pages, bounded by a wall-clock
// budget) and returns. Safe to call repeatedly — each call resumes from the
// persisted cursor, so an interrupted job continues rather than restarting.

import { leaseJob, commitChunk, failJob, getJob } from './kernel'
import type { Job, JobStatus, LeaseReason } from './types'

/** One page of work items plus the resume cursor for the next page. */
export interface JobPage<Item> {
  items:      Item[]
  nextCursor: string | null
  hasMore:    boolean
}

/**
 * The feature-specific half of a job. The runner supplies leasing, chunking,
 * committing, cancellation, and budgeting; the strategy supplies WHAT to fetch
 * and WHAT to do per item.
 *   Job   — the concrete job document type (extends the generic Job)
 *   Ctx   — per-chunk context produced by loadContext (opaque to the runner)
 *   Item  — a single unit of work
 */
export interface JobStrategy<J extends Job, Ctx, Item> {
  /** Per-chunk setup: resolve everything the page loop needs, or fail systemically. */
  loadContext(job: J): Promise<{ ok: true; ctx: Ctx } | { ok: false; error: string }>
  /** Fetch the next page of items after `cursor`. */
  fetchPage(job: J, ctx: Ctx, cursor: string | null, limit: number): Promise<JobPage<Item>>
  /** Process one item. A per-item failure is counted, never fails the whole job. */
  processItem(item: Item, job: J, ctx: Ctx): Promise<{ ok: boolean; error?: string }>
  /** Terminal hook, invoked once when the job reaches `completed`. Best-effort. */
  onComplete?(job: J, ctx: Ctx): Promise<void> | void
}

export interface RunnerConfig {
  collection:   string
  pageSize:     number
  budgetMs:     number
  leaseMs:      number
  /** GA-7C S2: max items processed concurrently WITHIN a page (bounded worker pool).
   *  Default 1 = the original strictly-sequential behavior. Safe to raise only when
   *  processItem is independent + idempotent per item (e.g. certificate generation:
   *  distinct registrations → distinct deterministic claims/ledgers → no duplicates).
   *  The commit is still per-page (order-independent deltas), the cursor still advances
   *  per-page, and per-item failures are still counted — so ordering, idempotency, and
   *  retry semantics are unchanged; only in-flight item count (and thus memory) rises. */
  concurrency?: number
}

export interface ProcessResult {
  done:      boolean                 // job reached a terminal state
  status:    JobStatus
  processed: number                  // items handled THIS call
  reason?:   LeaseReason
}

export async function runJobChunk<J extends Job, Ctx, Item>(
  jobId:    string,
  strategy: JobStrategy<J, Ctx, Item>,
  config:   RunnerConfig,
): Promise<ProcessResult> {
  const lease = await leaseJob<J>(config.collection, jobId, config.leaseMs)
  if (!lease.proceed) {
    return {
      done:   lease.reason === 'completed' || lease.reason === 'cancelled' || lease.reason === 'not_found',
      status: lease.reason === 'busy' ? 'processing' : (lease.reason === 'not_found' ? 'failed' : lease.reason),
      processed: 0,
      reason: lease.reason,
    }
  }

  const job = lease.job

  // Per-chunk setup (strategy). A systemic failure fails the whole job.
  const loaded = await strategy.loadContext(job)
  if (!loaded.ok) {
    await failJob(config.collection, jobId, loaded.error)
    return { done: true, status: 'failed', processed: 0 }
  }
  const ctx = loaded.ctx

  const startedAt   = Date.now()
  const concurrency = Math.max(1, config.concurrency ?? 1)
  let cursor    = job.cursor
  let processed = 0
  let status: JobStatus = 'processing'
  let leaseTag  = lease.leaseTag   // fencing token; renewed by each commitChunk

  // Process page-by-page, committing after each page, until the time budget is
  // spent, the job is exhausted, or cancellation is observed at commit.
  for (;;) {
    const { items, nextCursor, hasMore } = await strategy.fetchPage(job, ctx, cursor, config.pageSize)

    let succeeded = 0
    let failed    = 0
    let lastError: string | null = null
    // Bounded worker pool over the page's items. concurrency=1 → identical to the
    // original sequential loop. JS is single-threaded, so the shared counters are
    // race-free across the interleaved workers.
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const r = await strategy.processItem(items[next++], job, ctx)
        if (r.ok) succeeded++
        else { failed++; lastError = r.error ?? lastError }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))

    const finished = !hasMore
    const commit = await commitChunk(config.collection, jobId, {
      deltaProcessed: items.length,
      deltaSucceeded: succeeded,
      deltaFailed:    failed,
      cursor:         nextCursor,
      lastError,
      finished,
      leaseMs:        config.leaseMs,
      expectedLeaseTag: leaseTag,
    })

    // Lost the lease (a co-driver re-leased after ours expired): the commit was
    // rejected with no mutation. Stop and let the current owner continue from the
    // last committed cursor — never commit stale progress on top of it.
    if (commit.fenced) { status = commit.status; break }

    status    = commit.status
    leaseTag  = commit.leaseTag
    cursor    = nextCursor
    processed += items.length

    if (finished || status === 'cancelled') break
    if (Date.now() - startedAt >= config.budgetMs) break   // yield; caller resumes
  }

  // Terminal hook — read the just-committed job so the strategy sees final counts.
  if (status === 'completed' && strategy.onComplete) {
    const finalJob = await getJob<J>(config.collection, jobId)
    await strategy.onComplete(finalJob ?? job, ctx)
  }

  return { done: status === 'completed' || status === 'cancelled', status, processed }
}
