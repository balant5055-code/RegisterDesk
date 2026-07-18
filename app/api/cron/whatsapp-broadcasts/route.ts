// GET/POST /api/cron/whatsapp-broadcasts
//
// WA-3 — Scheduled driver for WhatsApp broadcast jobs. Mirrors the certificate /
// registration-import crons: a tick scans non-terminal jobs and advances each via
// the SAME processWhatsAppBroadcastChunk the send-now path uses. Reuse — not a
// second processing path.
//
// Safety (inherited from the generic runner + kernel):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply.
//   - No duplicate messages: each recipient is marked `sent`; a resumed chunk skips it.
//   - No duplicate billing: the wallet was charged once, up-front (chargeAndStartCampaign).
//   - Per-page atomic commit + cursor: an interrupted chunk resumes, never restarts.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveJobs }            from '@/lib/jobs/kernel'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import {
  processWhatsAppBroadcastChunk, WHATSAPP_BROADCAST_JOBS, type WhatsAppBroadcastJob,
} from '@/lib/broadcasts/whatsappJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const jobs  = await listActiveJobs<WhatsAppBroadcastJob>(WHATSAPP_BROADCAST_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break   // yield; next tick resumes the rest
    try {
      const r = await processWhatsAppBroadcastChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      console.error('[cron/whatsapp-broadcasts] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.whatsapp_broadcasts', area: 'broadcast', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs: Date.now() - start, jobs: outcomes })
}

export const GET  = withCronMetrics('whatsapp-broadcasts', handle)
export const POST = withCronMetrics('whatsapp-broadcasts', handle)
