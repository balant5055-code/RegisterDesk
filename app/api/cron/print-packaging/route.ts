// GET/POST /api/cron/print-packaging
//
// PA-6 — Scheduled driver for print-packaging jobs. Mirrors the other job crons: a
// tick scans non-terminal jobs and advances each via the SAME
// processPrintPackageChunk the create route uses. Reuse — not a second path.
//
// Safety (inherited from the runner):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply.
//   - Idempotent: a re-run recomputes the same metadata (RD-PRINT-P0 — nothing is
//     stored; the ZIP is rendered on demand at download time).
//   - Per-page commit + cursor: an interrupted build resumes, never double-runs.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs }            from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processPrintPackageChunk, PRINT_PACKAGE_JOBS, type PrintPackageJob,
} from '@/lib/printAssets/packageJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 55_000
const JOB_BATCH      = 25

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<PrintPackageJob>(PRINT_PACKAGE_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      const r = await processPrintPackageChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      // RD-PRINT-AUDIT · neither the log line nor the response (printed in the Actions log)
      // carries the exception's text — only its type and a fixed reason.
      console.error('[cron/print-packaging] job error:', { jobId: job.jobId, type: err instanceof Error ? err.name : typeof err })
      captureError(err, { scope: 'cron.print_packaging', area: 'print', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: 'packaging step failed' })
    }
  }

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('print-packaging', handle)
export const POST = withCronMetrics('print-packaging', handle)
