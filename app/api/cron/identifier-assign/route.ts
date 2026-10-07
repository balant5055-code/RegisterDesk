// GET/POST /api/cron/identifier-assign
//
// RD-EVENT-19E — Scheduled driver for identifier assignment jobs. Mirrors the
// registration-bulk / certificate / report-export crons: a tick scans non-terminal
// jobs and advances each via the SAME processIdentifierAssignmentChunk the create
// and process routes use. Reuse — not a second processing path.
//
// Safety (inherited from the runner and the identifier engine):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply, so
//     the cron and the organizer's own browser can never process the same chunk.
//   - No duplicate identifiers: every item allocates with `skipIfAssigned`, decided
//     inside the transaction, so a re-tick is a no-op for anyone already assigned.
//   - Per-page atomic commit + cursor: an interrupted chunk resumes, never restarts.
//   - A job whose event was cancelled or archived mid-run fails systemically rather
//     than continuing to hand out identifiers for an event that is not happening.
//
// Auth: the runner sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.
//
// ⚠️ SCHEDULING: this route is driven by .github/workflows/cron-runners.yml and by
// NOTHING else. vercel.json must not gain a second schedule for it — exactly one
// scheduler per route.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs } from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processIdentifierAssignmentChunk, IDENTIFIER_ASSIGNMENT_JOBS,
  type IdentifierAssignmentJob,
} from '@/lib/identifiers/assignmentJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<IdentifierAssignmentJob>(IDENTIFIER_ASSIGNMENT_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      const r = await processIdentifierAssignmentChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      console.error('[cron/identifier-assign] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.identifier_assign', area: 'identifiers', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('identifier-assign', handle)
export const POST = withCronMetrics('identifier-assign', handle)
