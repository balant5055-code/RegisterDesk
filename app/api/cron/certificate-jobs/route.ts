// GET/POST /api/cron/certificate-jobs
//
// Scheduled driver for bulk certificate generation jobs. Removes the dependency
// on an organizer's browser tab staying open: a cron tick scans non-terminal
// jobs and advances each via the SAME processJobChunk used by the client-driven
// /process endpoint. Reuse — not a second processing path.
//
// Safety (all inherited from processJobChunk):
//   - Leases: processJobChunk leases each job; a job already being driven (by a
//     browser tab, another cron tick, or an overlapping invocation) returns
//     `busy` and is skipped cheaply — never double-processed.
//   - No duplicate certificates: generation is idempotent via deterministic claims.
//   - No duplicate emails: emailCertificate is idempotent (skips already-sent).
//   - Per-page atomic commit + cursor: interrupted chunks resume, never double-count.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed when
// CRON_SECRET is unset.

import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { listActiveJobs, failJob }   from '@/lib/certificates/firestore'
import { loadEventContext, processJobChunk } from '@/lib/certificates/jobs'
import { listActiveZipJobs }         from '@/lib/certificates/zipJobsStore'
import { processZipJobChunk }        from '@/lib/certificates/zipJobs'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
// RD-CERT-SCALE-01 — the SAME continuation primitives the hardened broadcast crons use.
// No second continuation system is introduced.
import {
  readChainDepth, shouldChain, triggerChain,
  BUSY_RETRY_DELAY_MS, BUSY_RETRY_MAX_MS, sleep,
} from '@/lib/jobs/continuation'

export const dynamic     = 'force-dynamic'  // never cached
export const maxDuration = 60               // seconds (Vercel function budget)

const CRON_BUDGET_MS = 50_000  // leave headroom under maxDuration
const JOB_BATCH      = 25      // non-terminal jobs scanned per tick
const SELF_PATH      = '/api/cron/certificate-jobs'

interface JobOutcome {
  jobId:     string
  status:    string
  processed: number
  reason?:   string
}

async function handle(req: NextRequest): Promise<NextResponse> {
  // ── Auth (fail-closed) ─────────────────────────────────────────────────────
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  // RD-CERT-SCALE-01 — 0 on a scheduled tick, >0 when this invocation was summoned by the
  // previous chunk. Anything malformed reads as 0, so a forged header cannot deepen a chain.
  const depth = readChainDepth(req.headers)
  const jobs  = await listActiveJobs(JOB_BATCH)
  const outcomes: JobOutcome[] = []

  // Continuation inputs, accumulated across BOTH loops below. `advanced` is real work done
  // this invocation and `nonTerminal` is whether anything is still unfinished — `shouldChain`
  // requires both, which is what stops a job that cannot progress from spinning the endpoint.
  let advanced = 0, nonTerminal = 0

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break  // yield; next tick resumes the rest

    try {
      const ctx = await loadEventContext(job.organizerUid, job.eventId)
      if (!ctx.ok) {
        // Event gone entirely → the job can never proceed; fail it so it stops
        // being re-scanned. 'not_published' may be transient → just skip.
        if (ctx.code === 'not_found') {
          await failJob(job.jobId, 'event_not_found')
          outcomes.push({ jobId: job.jobId, status: 'failed', processed: 0, reason: 'event_not_found' })
        } else {
          outcomes.push({ jobId: job.jobId, status: job.status, processed: 0, reason: `ctx_${ctx.code}` })
        }
        continue
      }

      let r = await processJobChunk(job.jobId, ctx.ctx)

      // Only a CHAINED invocation waits out a lease — it is waiting for the worker that
      // summoned it, which has just handed the lease over. On a scheduled tick, `busy` means
      // another driver genuinely owns the job and we skip it, exactly as before.
      let waited = 0
      while (depth > 0 && r.reason === 'busy' && waited < BUSY_RETRY_MAX_MS && Date.now() - start < CRON_BUDGET_MS) {
        await sleep(BUSY_RETRY_DELAY_MS)
        waited += BUSY_RETRY_DELAY_MS
        r = await processJobChunk(job.jobId, ctx.ctx)
      }

      advanced += r.processed
      if (!r.done) nonTerminal++
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      // One job's failure must not stop the driver — but alert on it (same helpers as
      // the money crons). Retry is unaffected: the job stays active and resumes.
      console.error('[cron/certificate-jobs] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.certificate_jobs', area: 'certificate', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  // ── RD-CERT-ARTIFACT-01 · bulk-ZIP jobs ────────────────────────────────────
  // Same lease/fence/cursor machinery, driven from the same tick so no second scheduler
  // is introduced (exactly one scheduler per route remains the rule).
  //
  // The SAME pre-job budget check as the loop above is used deliberately: this change does
  // not touch the scheduler's budget arithmetic, which is tracked separately.
  const zipOutcomes: JobOutcome[] = []
  for (const zj of await listActiveZipJobs(JOB_BATCH)) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      const r = await processZipJobChunk(zj.jobId)
      // ZIP jobs share this tick, so they share the continuation decision: a half-built ZIP
      // is exactly as much a reason to come back as a half-issued batch.
      advanced += r.processed
      if (!r.done) nonTerminal++
      zipOutcomes.push({ jobId: zj.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      console.error('[cron/certificate-jobs] zip job error:', { jobId: zj.jobId, err })
      captureError(err, { scope: 'cron.certificate_zip_jobs', area: 'certificate', jobId: zj.jobId })
      zipOutcomes.push({ jobId: zj.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  // RD-CERT-SCALE-01 — summon the next invocation, once, after the response is sent.
  //
  // `shouldChain` requires BOTH real progress and unfinished work, so a finished batch does
  // not chain (`skipped_terminal`) and a job that cannot advance stops the chain rather than
  // hammering the endpoint (`skipped_no_progress`). Depth is capped at MAX_CHAIN_DEPTH.
  //
  // Exactly one dispatch per invocation, and `triggerChain` is best-effort by contract — it
  // never throws and a failed dispatch is NOT a job failure. If it is dropped, the 5-minute
  // cron still picks the job up from its persisted cursor and the reaper remains the backstop,
  // so this is an accelerator, never a dependency.
  const chain = shouldChain({ advanced, nonTerminal, depth })
  if (chain === 'dispatched') after(() => triggerChain(SELF_PATH, depth))

  await flushMonitoring()   // deliver any events captured during this serverless run
  return NextResponse.json({
    scanned:   jobs.length,
    durationMs: Date.now() - start,
    advanced,
    nonTerminal,
    depth,
    chain,
    jobs:      outcomes,
    zipJobs:   zipOutcomes,
  })
}

export const GET  = withCronMetrics('certificate-jobs', handle)
export const POST = withCronMetrics('certificate-jobs', handle)
