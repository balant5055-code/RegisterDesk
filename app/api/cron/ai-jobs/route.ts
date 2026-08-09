// GET/POST /api/cron/ai-jobs
//
// Scheduled driver for the AI queue. A tick claims due jobs and runs each through its
// provider, exactly as `/api/cron/certificate-jobs` drives certificate batches — the same
// shape, the same auth, the same budget discipline.
//
// ═══ INERT IN THIS SPRINT ═════════════════════════════════════════════════════
// No AI provider is implemented, so the registry is empty, nothing is claimable, and every
// tick returns `{ dispatched: 0, reason: 'no_provider' }`. The route exists so the pipeline
// is complete and schedulable the day a provider lands; it calls nothing today.
// ══════════════════════════════════════════════════════════════════════════════
//
// Safety (all inherited from the dispatcher):
//   - Leases + fencing: a job already being run by an overlapping tick is skipped, never
//     processed twice. A provider inference is metered, so a double-run costs real money.
//   - Attempts are counted at CLAIM, so a job that kills its worker cannot loop forever.
//   - Backoff: a failed attempt is rescheduled, not immediately retried.
//   - Budgeted: the loop yields before the function timeout and the next tick resumes.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed when
// CRON_SECRET is unset.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { listActiveJobs } from '@/lib/jobs/kernel'
import { drain } from '@/features/ai/services/dispatcher'
import { runAnalyzeGalleryChunk } from '@/features/ai/jobs/analyzeGalleryJob'
import { AI_BATCHES } from '@/features/ai/types'
import { isPipelineConfigured } from '@/features/ai/providers'
import { bootstrapAI } from '@/features/ai/bootstrap'

export const dynamic     = 'force-dynamic'  // never cached
export const maxDuration = 60               // seconds (Vercel function budget)

const CRON_BUDGET_MS = 50_000  // leave headroom under maxDuration
const MAX_JOBS       = 25      // claimable jobs scanned per tick
const MAX_BATCHES    = 5       // open batches advanced per tick
const BATCH_BUDGET_MS = 15_000 // fan-out share of the tick; the rest goes to dispatch

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  // Short-circuit before touching Firestore: with no provider there is nothing a scan could
  // usefully return, and a tick that reads the queue every minute to discover that would be
  // pure cost.
  if (!isPipelineConfigured()) {
    return NextResponse.json({
      scanned: 0, dispatched: 0, completed: 0, retried: 0, failed: 0, skipped: 0,
      durationMs: 0, reason: 'no_provider',
    })
  }

  // Registers every capability's result consumer BEFORE anything can produce a result.
  bootstrapAI()

  try {
    // ── Fan out ────────────────────────────────────────────────────────────────
    // Advance any open batch first, so a gallery an organizer just submitted has jobs in
    // the queue by the time the drain below looks for them. Each batch is leased and
    // cursor-resumed by `lib/jobs`, so an overlapping tick is safe and cheap.
    const start   = Date.now()
    const batches = await listActiveJobs(AI_BATCHES, MAX_BATCHES)
    let advanced  = 0
    for (const batch of batches) {
      if (Date.now() - start > BATCH_BUDGET_MS) break
      try {
        await runAnalyzeGalleryChunk(batch.jobId, BATCH_BUDGET_MS)
        advanced++
      } catch (err) {
        // One batch's failure must not stop the driver. The job keeps its cursor and
        // resumes on the next tick.
        console.error('[cron/ai-jobs] batch error:', { jobId: batch.jobId, err })
        captureError(err, { scope: 'cron.ai_jobs', area: 'ai', jobId: batch.jobId })
      }
    }

    const report = await drain({
      budgetMs: CRON_BUDGET_MS - (Date.now() - start),
      maxJobs:  MAX_JOBS,
    })
    return NextResponse.json({ ...report, batchesScanned: batches.length, batchesAdvanced: advanced })
  } catch (err) {
    // The dispatcher already isolates per-job failures; reaching here means the scan itself
    // broke. Alert rather than fail silently — the same helpers the money crons use.
    console.error('[cron/ai-jobs] drain error:', err)
    captureError(err, { scope: 'cron.ai_jobs', area: 'ai' })
    return NextResponse.json(
      { error: 'AI queue drain failed', detail: err instanceof Error ? err.message : 'error' },
      { status: 500 },
    )
  } finally {
    await flushMonitoring()   // deliver any events captured during this serverless run
  }
}

export const GET  = withCronMetrics('ai-jobs', handle)
export const POST = withCronMetrics('ai-jobs', handle)
