// POST /api/organizer/broadcasts/[campaignId]/cancel
//
// Cancels a broadcast:
//   • SCHEDULED (any channel) — cancel before it starts (status-guarded txn).
//   • SENDING WhatsApp (WA-3) — cancel the running send job; the runner stops at the
//     next page/commit and already-sent recipients are kept (no re-send, no refund
//     here — WA-4). The campaign is marked 'cancelled' with the counts sent so far.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { logBroadcastAction }        from '@/lib/broadcasts/audit'
import { cancelJob, getJob }         from '@/lib/jobs/kernel'
import type { Job }                  from '@/lib/jobs/types'
import { campaignJobPointer }        from '@/lib/broadcasts/broadcastJobs'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid
  const callerUid = authz.callerUid

  const { campaignId } = await params
  const ref  = adminDb.collection('broadcastCampaigns').doc(campaignId)
  const snap = await ref.get()
  const d = snap.data() as { organizerUid?: string; status?: string; channel?: string; whatsappJobId?: string; emailJobId?: string } | undefined
  if (!snap.exists || d?.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  // ── Running campaign (email or WhatsApp) — cancel the job, keep what was sent ─
  const ptr = campaignJobPointer(d)
  if (d.status === 'sending' && ptr.jobId) {
    await cancelJob(ptr.collection, ptr.jobId)
    const job = await getJob<Job>(ptr.collection, ptr.jobId)
    await ref.update({
      status:       'cancelled',
      successCount: job?.counts.succeeded ?? 0,
      failCount:    job?.counts.failed ?? 0,
      sentAt:       FieldValue.serverTimestamp(),
      updatedAt:    FieldValue.serverTimestamp(),
    })
    void logBroadcastAction({
      organizerUid: uid, actorUid: callerUid, action: 'broadcast.cancelled', campaignId,
      metadata: { successCount: job?.counts.succeeded ?? 0, failCount: job?.counts.failed ?? 0 },
    }).catch(() => {})
    return NextResponse.json({ success: true })
  }

  // ── Scheduled campaign — cancel before it starts (race-safe txn) ─────────────
  const result = await adminDb.runTransaction<{ ok: boolean; status: number; error?: string }>(async txn => {
    const s = await txn.get(ref)
    const cur = s.data() as { status?: string } | undefined
    if (!s.exists) return { ok: false, status: 404, error: 'Campaign not found' }
    if (cur?.status !== 'scheduled') return { ok: false, status: 409, error: 'Only scheduled or sending broadcasts can be cancelled.' }
    txn.update(ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true, status: 200 }
  })

  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: result.status })

  void logBroadcastAction({
    organizerUid: uid, actorUid: callerUid, action: 'broadcast.cancelled', campaignId,
  }).catch(() => {})

  return NextResponse.json({ success: true })
}
