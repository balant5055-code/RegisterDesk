// GET/POST /api/cron/registration-import
//
// RM-2.3A — Scheduled driver for bulk registration-import jobs. Mirrors the
// certificate-jobs cron exactly: a tick scans non-terminal jobs and advances each
// via the SAME processRegistrationImportChunk used by the client-driven /process
// endpoint. Reuse — not a second processing path.
//
// Safety (all inherited from the generic runner + kernel):
//   - Leases: each job is leased; a job already being driven (browser tab, another
//     cron tick, overlapping invocation) returns `busy` and is skipped cheaply.
//   - No duplicate registrations: createRegistration is idempotent per row via the
//     stable import fingerprint idempotency key.
//   - Per-page atomic commit + cursor: interrupted chunks resume, never double-count.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed when
// CRON_SECRET is unset.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs }            from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processRegistrationImportChunk, REGISTRATION_IMPORT_JOBS, type RegistrationImportJob,
} from '@/lib/registrations/importJob'

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
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<RegistrationImportJob>(REGISTRATION_IMPORT_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break  // yield; next tick resumes the rest

    try {
      const r = await processRegistrationImportChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      // One job's failure must not stop the driver.
      console.error('[cron/registration-import] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.registration_import', area: 'registration', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('registration-import', handle)
export const POST = withCronMetrics('registration-import', handle)
