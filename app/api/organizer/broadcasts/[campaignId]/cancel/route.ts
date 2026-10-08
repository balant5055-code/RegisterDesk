// POST /api/organizer/broadcasts/[campaignId]/cancel
//
// Cancels a broadcast:
//   • SCHEDULED (any channel) — cancel before it starts (status-guarded txn).
//   • SENDING WhatsApp (WA-3) — cancel the running send job; the runner stops at the
//     next page/commit and already-sent recipients are kept (no re-send). The campaign is
//     marked 'cancelled' with the counts sent so far.
//
// RD-INTEG · D3 — billing: charge on accept. Every recipient WhatsApp never accepted is given
// back (money or prepaid units) by settleBroadcastBilling — NOT here: a worker can lease the job
// between any read this route makes and cancelJob, and would then send a page after a settlement
// computed here. The worker settles after its last commit (syncCampaignTerminal); the
// whatsapp-broadcasts cron sweep settles everything else once the job has been quiet for longer
// than a page can take.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { logBroadcastAction }        from '@/lib/broadcasts/audit'
import { cancelJob, getJob }         from '@/lib/jobs/kernel'
import type { Job }                  from '@/lib/jobs/types'
import { campaignJobPointer }        from '@/lib/broadcasts/broadcastJobs'
import { countAcceptedRecipients }   from '@/lib/broadcasts/whatsappJob'
import { transitionCampaign }        from '@/lib/broadcasts/jobPreparation'

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
    // RD-COMMS-P2-B — a job that already FINISHED cannot be cancelled: its completion (finalize)
    // owns the campaign's final state. cancelJob reports that instead of cancelling it.
    const jobStatus = await cancelJob(ptr.collection, ptr.jobId)
    if (jobStatus === 'completed') {
      return NextResponse.json({ success: false, error: 'This broadcast has already finished sending.' }, { status: 409 })
    }
    const job = await getJob<Job>(ptr.collection, ptr.jobId)
    const isWhatsApp = d.channel === 'whatsapp'
    // WhatsApp: the sent flags are the truth (the runner counter can over-count a re-run page).
    const succeeded = isWhatsApp ? await countAcceptedRecipients(ptr.jobId) : (job?.counts.succeeded ?? 0)
    const failed    = isWhatsApp ? Math.max(0, (job?.counts.total ?? 0) - succeeded) : (job?.counts.failed ?? 0)
    // Status-GUARDED: only a campaign still `sending` becomes cancelled — never one a concurrent
    // finalize / fail has already ended (sent → cancelled cannot happen).
    const moved = await transitionCampaign(ref, ['sending'], {
      status:       'cancelled',
      successCount: succeeded,
      failCount:    failed,
      sentAt:       FieldValue.serverTimestamp(),
    })
    if (!moved) {
      return NextResponse.json({ success: false, error: 'This broadcast has already finished.' }, { status: 409 })
    }
    void logBroadcastAction({
      organizerUid: uid, actorUid: callerUid, action: 'broadcast.cancelled', campaignId,
      metadata: { successCount: succeeded, failCount: failed },
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
