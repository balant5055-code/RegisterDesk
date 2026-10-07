// GET/POST /api/cron/timing-tags
//
// RD-EVENT-19F-B — Scheduled driver for timing tag import jobs. Mirrors the
// registration-bulk / identifier-assign crons: a tick scans non-terminal jobs and
// advances each via the SAME processTimingTagImportChunk the routes use. Reuse —
// not a second processing path.
//
// Safety, all inherited:
//   - Leases: a job the organizer's browser is already driving returns `busy`.
//   - No duplicate mappings: every row goes through assignTimingTag, which is a
//     no-op when the participant already carries that device.
//   - Per-page atomic commit + cursor: an interrupted chunk resumes, never restarts.
//   - An event cancelled or archived mid-import fails the job systemically.
//
// ⚠️ SCHEDULING: driven by .github/workflows/cron-runners.yml and by nothing else.
// vercel.json must not gain a second schedule for it — one scheduler per route.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs } from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processTimingTagImportChunk, TIMING_TAG_IMPORT_JOBS,
  type TimingTagImportJob,
} from '@/lib/identifiers/timingTagImportJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<TimingTagImportJob>(TIMING_TAG_IMPORT_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      const r = await processTimingTagImportChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      console.error('[cron/timing-tags] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.timing_tags', area: 'identifiers', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('timing-tags', handle)
export const POST = withCronMetrics('timing-tags', handle)
