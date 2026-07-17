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
import { listActiveJobs, failJob }   from '@/lib/certificates/firestore'
import { loadEventContext, processJobChunk } from '@/lib/certificates/jobs'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'

export const dynamic     = 'force-dynamic'  // never cached
export const maxDuration = 60               // seconds (Vercel function budget)

const CRON_BUDGET_MS = 50_000  // leave headroom under maxDuration
const JOB_BATCH      = 25      // non-terminal jobs scanned per tick

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
  const jobs  = await listActiveJobs(JOB_BATCH)
  const outcomes: JobOutcome[] = []

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

      const r = await processJobChunk(job.jobId, ctx.ctx)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      // One job's failure must not stop the driver — but alert on it (same helpers as
      // the money crons). Retry is unaffected: the job stays active and resumes.
      console.error('[cron/certificate-jobs] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.certificate_jobs', area: 'certificate', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()   // deliver any events captured during this serverless run
  return NextResponse.json({
    scanned:   jobs.length,
    durationMs: Date.now() - start,
    jobs:      outcomes,
  })
}

export const GET  = withCronMetrics('certificate-jobs', handle)
export const POST = withCronMetrics('certificate-jobs', handle)
