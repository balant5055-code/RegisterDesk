// GET/POST /api/cron/certificate-email-jobs
//
// RD-CERT-EMAIL-BULK — the scheduled driver for bulk certificate EMAIL DELIVERY.
//
// ═══ WHY A DEDICATED ROUTE ═══════════════════════════════════════════════════
// /api/cron/certificate-jobs already drives generation AND bulk-ZIP jobs against ONE
// shared 50s budget, so whichever loop runs first can starve the others. Delivery is
// provider-bound rather than CPU-bound and would lose that race every time. Giving it its
// own invocation means a long generation backlog can never stall attendee email, and each
// route keeps a budget it fully owns.
//
// Safety is inherited, not reinvented:
//   - the job LEASE means a slow tick and the next tick can never both advance one job;
//   - the CURSOR means an invocation that ends mid-run resumes exactly where it stopped;
//   - the Phase 2B certificate CLAIM means replaying a page re-sends nothing.
// So a closed browser, a killed function or a deployment mid-run costs time, never a
// duplicate email.
//
// Auth: the shared cron secret, fail-closed — identical to every other cron route.

import { NextRequest, NextResponse } from 'next/server'
import { listActiveEmailJobs }    from '@/lib/certificates/emailJobsStore'
import { processEmailJobChunk }   from '@/lib/certificates/emailJobs'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics }        from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'

export const dynamic     = 'force-dynamic'  // never cached
export const maxDuration = 60               // seconds (matches the other cron runners)

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
  const outcomes: JobOutcome[] = []

  for (const job of await listActiveEmailJobs(JOB_BATCH)) {
    if (Date.now() - start > CRON_BUDGET_MS) break   // yield; the next tick resumes the rest
    try {
      const r = await processEmailJobChunk(job.jobId)
      outcomes.push({ jobId: job.jobId, status: r.status, processed: r.processed, reason: r.reason })
    } catch (err) {
      // One job's failure must not stop the driver — the job keeps its cursor and is
      // retried on the next tick.
      console.error('[cron/certificate-email-jobs] job error:', { jobId: job.jobId, err })
      captureError(err, { scope: 'cron.certificate_email_jobs', area: 'certificate', jobId: job.jobId })
      outcomes.push({
        jobId: job.jobId, status: 'error', processed: 0,
        reason: err instanceof Error ? err.message : 'error',
      })
    }
  }

  await flushMonitoring()   // deliver any events captured during this serverless run
  return NextResponse.json({
    scanned:    outcomes.length,
    durationMs: Date.now() - start,
    jobs:       outcomes,
  })
}

export const GET  = withCronMetrics('certificate-email-jobs', handle)
export const POST = withCronMetrics('certificate-email-jobs', handle)
