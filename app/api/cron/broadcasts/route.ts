// GET/POST /api/cron/broadcasts
//
// Runs every minute. Finds scheduled broadcasts whose time has arrived and starts
// them through the SAME path send-now uses (startBroadcastCampaign): atomic bill +
// transition scheduled→sending, then deliver. The transition is status-guarded, so
// overlapping cron runs can never double-bill or double-send a campaign.
//
// Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail-closed.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }                 from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { isAuthorizedCron, cronUnauthorized } from '@/lib/cron/auth'
import { startBroadcastCampaign }    from '@/lib/broadcasts/send'
import type { BroadcastChannel }     from '@/lib/broadcasts/types'
import { captureError, flushMonitoring } from '@/lib/monitoring/sentry'
import { recordCronExecution } from '@/lib/monitoring/cronMetrics'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const MAX_PER_RUN = 25   // bounded per invocation; the next minute picks up the rest

async function handle(req: NextRequest): Promise<NextResponse> {
  if (!isAuthorizedCron(req)) return cronUnauthorized()

  let ok = false, detail = ''
  try {
    // Due scheduled campaigns: status == 'scheduled' AND scheduledFor <= now.
    const snap = await adminDb.collection('broadcastCampaigns')
      .where('status', '==', 'scheduled')
      .where('scheduledFor', '<=', Timestamp.now())
      .orderBy('scheduledFor', 'asc')
      .limit(MAX_PER_RUN)
      .get()

    let started = 0, skipped = 0, failed = 0
    for (const doc of snap.docs) {
      const d = doc.data() as { organizerUid?: string; createdBy?: string; channel?: BroadcastChannel; recipientCount?: number }
      const result = await startBroadcastCampaign({
        campaignId:     doc.id,
        organizerUid:   d.organizerUid ?? '',
        actorUid:       d.createdBy ?? d.organizerUid ?? '',
        channel:        d.channel ?? 'email',
        recipientCount: d.recipientCount ?? 0,
      })
      if (result.ok) started++
      else if (result.reason === 'insufficient_balance') failed++
      else skipped++   // bad_state — already started by a concurrent run
    }

    ok = true; detail = JSON.stringify({ scanned: snap.size, started, failed, skipped })
    return NextResponse.json({ scanned: snap.size, started, failed, skipped })
  } catch (err) {
    detail = err instanceof Error ? err.message : 'error'
    captureError(err, { scope: 'cron.broadcasts' })
    return NextResponse.json({ error: 'cron_failed' }, { status: 500 })
  } finally {
    await recordCronExecution('broadcasts', { ok, detail }).catch(() => {})
    await flushMonitoring()
  }
}

export async function GET(req: NextRequest):  Promise<NextResponse> { return handle(req) }
export async function POST(req: NextRequest): Promise<NextResponse> { return handle(req) }
