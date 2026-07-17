// GET/POST /api/cron/storage-cleanup
//
// GA-7C S2/P3: reclaims TRANSIENT storage artifacts — the one-time-download outputs
// of the async report-export and print-package jobs — after a retention window. Both
// are regenerable by re-running their originating job, so deleting an old copy is
// safe. It NEVER touches active assets (generated certificates, templates, brand kit,
// the organizer asset library, or the re-packageable printAssets badge PDFs).
//
// Reuses the existing cron infrastructure (isAuthorizedCron fail-closed auth +
// withCronMetrics) and the storage admin bucket — no new system. Bounded per tick.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed when unset.

import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { withCronMetrics } from '@/lib/cron/withMetrics'
import { deleteOldObjects } from '@/lib/firebase/storage/admin'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// TRANSIENT, one-time-download job outputs — safe to reclaim. Keeping any active or
// served-asset prefix OUT of this list is the safety contract for deleteOldObjects.
const TRANSIENT_PREFIXES = ['reportExports/', 'printPackages/']
const RETENTION_MS   = 7 * 24 * 60 * 60 * 1000   // keep for 7 days after creation
const MAX_PER_PREFIX = 500                        // bounded per tick (single page)

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  const results: Array<{ prefix: string; scanned: number; deleted: number }> = []
  for (const prefix of TRANSIENT_PREFIXES) {
    try {
      const { scanned, deleted } = await deleteOldObjects(prefix, RETENTION_MS, MAX_PER_PREFIX)
      results.push({ prefix, scanned, deleted })
    } catch (err) {
      // One prefix's failure must not stop the sweep — alert and continue.
      captureError(err, { scope: 'cron.storage_cleanup', prefix })
      results.push({ prefix, scanned: 0, deleted: 0 })
    }
  }

  await flushMonitoring()
  return NextResponse.json({ retentionDays: 7, results })
}

export const GET  = withCronMetrics('storage-cleanup', handle)
export const POST = withCronMetrics('storage-cleanup', handle)
