// GET/POST /api/cron/email-broadcasts
//
// OE-2 — Scheduled driver for email broadcast jobs. Mirrors the whatsapp-broadcasts
// / registration-import crons: a tick scans non-terminal jobs and advances each via
// the SAME processEmailBroadcastChunk the send-now path uses. Reuse — not a second
// processing path.
//
// RD-JOB-CONT-01 — this route is now BOTH the scheduled backstop and the target of a
// job's own continuation chain. A chunk that yields on budget asks for the next
// invocation immediately (see lib/jobs/continuation.ts) instead of waiting up to five
// minutes for the next tick — which is what left a 218-recipient campaign stranded at
// 54/218 until it was cancelled by hand.
//
// Safety (inherited from the runner — unchanged):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply.
//   - No duplicate emails: each recipient is marked `sent` (awaited); a resumed chunk skips it.
//   - No duplicate billing: email is free (nothing charged).
//   - Per-page atomic commit + cursor: an interrupted chunk resumes, never restarts.
//
// Auth: Vercel Cron / GitHub Actions / the chain send `Authorization: Bearer <CRON_SECRET>`.
// Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { listActiveJobs }            from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  readChainDepth, shouldChain, triggerChain,
  BUSY_RETRY_DELAY_MS, BUSY_RETRY_MAX_MS, sleep,
} from '@/lib/jobs/continuation'
import {
  processEmailBroadcastChunk, EMAIL_BROADCAST_JOBS, type EmailBroadcastJob,
} from '@/lib/broadcasts/emailJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25
const SELF_PATH      = '/api/cron/email-broadcasts'

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const depth = readChainDepth(req.headers)
  const jobs  = await listActiveJobs<EmailBroadcastJob>(EMAIL_BROADCAST_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  let advanced = 0, busy = 0, errored = 0, nonTerminal = 0

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      let r = await processEmailBroadcastChunk(job.jobId)

      // A chained invocation arrives while the worker that summoned it still holds its
      // lease (60s lease vs 45s budget). Waiting it out here is what makes the chain work
      // WITHOUT releasing the lease early — the fencing in lib/jobs/kernel.ts is untouched
      // on purpose, because it is shared with certificates, prints, imports and reports.
      // Scheduled ticks never wait: a `busy` job there genuinely belongs to someone else.
      let waited = 0
      while (depth > 0 && r.reason === 'busy' && waited < BUSY_RETRY_MAX_MS && Date.now() - start < CRON_BUDGET_MS) {
        await sleep(BUSY_RETRY_DELAY_MS)
        waited += BUSY_RETRY_DELAY_MS
        r = await processEmailBroadcastChunk(job.jobId)
      }

      advanced += r.processed
      if (r.reason === 'busy') busy++
      if (!r.done) nonTerminal++
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      errored++
      console.error('[cron/email-broadcasts] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.email_broadcasts', area: 'broadcast', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  // Chain only after REAL progress on a job that is still unfinished — see shouldChain.
  const chain = shouldChain({ advanced, nonTerminal, depth })
  if (chain === 'dispatched') {
    // after(): the response is already sent, so the child is invoked without this run
    // waiting on it. If the dispatch is dropped, the 5-minute tick and the reaper remain.
    after(() => triggerChain(SELF_PATH, depth))
  }

  // Recorded directly (like /api/cron/broadcasts) rather than via withCronMetrics, so the
  // detail distinguishes advanced / busy / errored. Previously every run wrote
  // `status=200` — a job failing on every single tick was indistinguishable from an idle
  // scan, which is a large part of why this went unnoticed.
  const durationMs = Date.now() - start
  void recordCronExecution('email-broadcasts', {
    ok: errored === 0,
    durationMs,
    detail: JSON.stringify({ scanned: jobs.length, advanced, busy, errored, nonTerminal, depth, chain }),
  }).catch(() => {})

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs, advanced, busy, errored, depth, chain, jobs: outcomes })
}

export const GET  = handle
export const POST = handle
