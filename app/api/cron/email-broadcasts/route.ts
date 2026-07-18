// GET/POST /api/cron/email-broadcasts
//
// OE-2 — Scheduled driver for email broadcast jobs. Mirrors the whatsapp-broadcasts
// / registration-import crons: a tick scans non-terminal jobs and advances each via
// the SAME processEmailBroadcastChunk the send-now path uses. Reuse — not a second
// processing path.
//
// Safety (inherited from the runner):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply.
//   - No duplicate emails: each recipient is marked `sent`; a resumed chunk skips it.
//   - No duplicate billing: email is free (nothing charged).
//   - Per-page atomic commit + cursor: an interrupted chunk resumes, never restarts.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs }            from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processEmailBroadcastChunk, EMAIL_BROADCAST_JOBS, type EmailBroadcastJob,
} from '@/lib/broadcasts/emailJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<EmailBroadcastJob>(EMAIL_BROADCAST_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break
    try {
      const r = await processEmailBroadcastChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      console.error('[cron/email-broadcasts] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.email_broadcasts', area: 'broadcast', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('email-broadcasts', handle)
export const POST = withCronMetrics('email-broadcasts', handle)
