// GET/POST /api/cron/registration-bulk
//
// OE-1 — Scheduled driver for bulk check-in / bulk restore jobs. Mirrors the
// certificate / registration-import / whatsapp-broadcasts crons: a tick scans
// non-terminal jobs and advances each via the SAME processRegistrationBulkChunk
// used by the create/process routes. Reuse — not a second processing path.
//
// Safety (inherited from the runner + the transactional services):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply.
//   - No duplicate check-ins: checkInRegistration is idempotent (checkedIn guard).
//   - No over-capacity restores: restoreRegistration re-checks capacity per item, atomically.
//   - Per-page atomic commit + cursor: an interrupted chunk resumes, never restarts.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs }            from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processRegistrationBulkChunk, REGISTRATION_BULK_JOBS, type RegistrationBulkJob,
} from '@/lib/registrations/bulkJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<RegistrationBulkJob>(REGISTRATION_BULK_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      const r = await processRegistrationBulkChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      console.error('[cron/registration-bulk] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.registration_bulk', area: 'registration', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('registration-bulk', handle)
export const POST = withCronMetrics('registration-bulk', handle)
