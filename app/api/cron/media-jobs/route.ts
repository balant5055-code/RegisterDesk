// GET/POST /api/cron/media-jobs
//
// Scheduled trigger for media maintenance: drive open bulk batches, then reclaim stranded
// objects.
//
// ═══ THIS ROUTE CONTAINS NO LOGIC ═════════════════════════════════════════════
// Every line of the pipeline lives in `features/media-studio/services/maintenanceService.ts`
// and is shared, unmodified, with the manual Maintenance page (RD-MEDIA-05). This file is a
// trigger and an auth check, nothing more — which is the whole point: whichever way
// maintenance is invoked, the same code runs and the same run is recorded.
//
// It is currently UNSCHEDULED (`vercel.json` carries no crons). That is why the manual page
// exists; this route stays so that adding a schedule later needs no code change at all.
// ══════════════════════════════════════════════════════════════════════════════
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed when unset.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { runMediaMaintenance } from '@/features/media-studio/services/maintenanceService'

export const dynamic     = 'force-dynamic'  // never cached
export const maxDuration = 60               // seconds (Vercel function budget)

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  try {
    // `ranBy: null` marks a scheduled run. The service never throws, so the try/catch below
    // guards only against something outside it going wrong.
    const run = await runMediaMaintenance({ trigger: 'cron', ranBy: null })
    return NextResponse.json(run)
  } catch (err) {
    console.error('[cron/media-jobs] maintenance failed:', err)
    captureError(err, { scope: 'cron.media_jobs', area: 'media' })
    return NextResponse.json({ error: 'Media maintenance failed' }, { status: 500 })
  } finally {
    await flushMonitoring()   // deliver any events captured during this serverless run
  }
}

export const GET  = withCronMetrics('media-jobs', handle)
export const POST = withCronMetrics('media-jobs', handle)
