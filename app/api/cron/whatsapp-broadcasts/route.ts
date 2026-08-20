// GET/POST /api/cron/whatsapp-broadcasts
//
// WA-3 — Scheduled driver for WhatsApp broadcast jobs. Mirrors the certificate /
// registration-import crons: a tick scans non-terminal jobs and advances each via
// the SAME processWhatsAppBroadcastChunk the send-now path uses. Reuse — not a
// second processing path.
//
// RD-JOB-CONT-01 — this route is now BOTH the scheduled backstop and the target of a job's
// own continuation chain, exactly as the email cron is. WhatsApp had the identical
// one-chunk-per-tick defect: any broadcast needing more than one worker budget depended on
// repeated scheduled ticks that are not reliably delivered. No message, template, provider,
// billing, dedupe or authorization behaviour changes here — only how the next chunk is
// summoned.
//
// Safety (inherited from the generic runner + kernel — unchanged):
//   - Leases: a job already being driven returns `busy` and is skipped cheaply.
//   - No duplicate messages: each recipient is marked `sent` (awaited); a resumed chunk skips it.
//   - No duplicate billing: the wallet was charged once, up-front (chargeAndStartCampaign).
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
  processWhatsAppBroadcastChunk, WHATSAPP_BROADCAST_JOBS, type WhatsAppBroadcastJob,
} from '@/lib/broadcasts/whatsappJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const CRON_BUDGET_MS = 50_000
const JOB_BATCH      = 25
const SELF_PATH      = '/api/cron/whatsapp-broadcasts'

interface JobOutcome { jobId: string; status: string; processed: number; reason?: string }

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const start = Date.now()
  const depth = readChainDepth(req.headers)
  const jobs  = await listActiveJobs<WhatsAppBroadcastJob>(WHATSAPP_BROADCAST_JOBS, JOB_BATCH)
  const outcomes: JobOutcome[] = []

  let advanced = 0, busy = 0, errored = 0, nonTerminal = 0

  for (const job of jobs) {
    if (Date.now() - start > CRON_BUDGET_MS) break   // yield; next tick resumes the rest
    try {
      let r = await processWhatsAppBroadcastChunk(job.jobId)

      // Only a CHAINED invocation waits out a lease — it is waiting for the worker that
      // summoned it. On a scheduled tick, `busy` means another driver genuinely owns the
      // job and we skip it, exactly as before.
      let waited = 0
      while (depth > 0 && r.reason === 'busy' && waited < BUSY_RETRY_MAX_MS && Date.now() - start < CRON_BUDGET_MS) {
        await sleep(BUSY_RETRY_DELAY_MS)
        waited += BUSY_RETRY_DELAY_MS
        r = await processWhatsAppBroadcastChunk(job.jobId)
      }

      advanced += r.processed
      if (r.reason === 'busy') busy++
      if (!r.done) nonTerminal++
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      errored++
      console.error('[cron/whatsapp-broadcasts] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.whatsapp_broadcasts', area: 'broadcast', jobId: job.jobId })
      outcomes.push({ jobId: job.jobId, status: 'error', processed: 0, reason: err instanceof Error ? err.message : 'error' })
    }
  }

  const chain = shouldChain({ advanced, nonTerminal, depth })
  if (chain === 'dispatched') after(() => triggerChain(SELF_PATH, depth))

  const durationMs = Date.now() - start
  void recordCronExecution('whatsapp-broadcasts', {
    ok: errored === 0,
    durationMs,
    detail: JSON.stringify({ scanned: jobs.length, advanced, busy, errored, nonTerminal, depth, chain }),
  }).catch(() => {})

  await flushMonitoring()   // deliver captured events before the serverless run ends
  return NextResponse.json({ scanned: jobs.length, durationMs, advanced, busy, errored, depth, chain, jobs: outcomes })
}

export const GET  = handle
export const POST = handle
