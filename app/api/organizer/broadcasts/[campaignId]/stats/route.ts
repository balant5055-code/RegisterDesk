// GET /api/organizer/broadcasts/[campaignId]/stats
//
// WA-2 — WhatsApp delivery summary for one broadcast campaign, aggregated from the
// emailLogs rows the status webhook updates. Read-only. Security: auth + ownership.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import type { WhatsAppDeliveryStatus, EmailLogStatus } from '@/lib/email-logs/types'

export interface BroadcastWhatsAppStats {
  total:       number   // rows logged for this campaign
  sent:        number   // accepted by Meta (total − failed)
  delivered:   number
  read:        number
  failed:      number
  deliveryPct: number   // delivered / sent
  readPct:     number   // read / delivered
  failurePct:  number   // failed / total
}

export type GetBroadcastStatsResponse =
  | { success: true;  stats: BroadcastWhatsAppStats }
  | { success: false; error: string }

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : 0)

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse<GetBroadcastStatsResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { campaignId } = await context.params

  // Ownership — the campaign must belong to this workspace.
  const campSnap = await adminDb.collection('broadcastCampaigns').doc(campaignId).get()
  if (!campSnap.exists || (campSnap.data() as { organizerUid?: string }).organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  const logsSnap = await adminDb.collection('emailLogs').where('campaignId', '==', campaignId).get()

  let total = 0, delivered = 0, read = 0, failed = 0
  for (const doc of logsSnap.docs) {
    total++
    const d  = doc.data() as { waStatus?: WhatsAppDeliveryStatus; status?: EmailLogStatus }
    const wa = d.waStatus
    if (wa === 'read')            { read++; delivered++ }
    else if (wa === 'delivered')  { delivered++ }
    else if (wa === 'failed' || d.status === 'failed') { failed++ }
    // else: accepted ('sent'), awaiting a delivery callback.
  }
  const sent = Math.max(0, total - failed)

  const stats: BroadcastWhatsAppStats = {
    total, sent, delivered, read, failed,
    deliveryPct: pct(delivered, sent),
    readPct:     pct(read, delivered),
    failurePct:  pct(failed, total),
  }
  return NextResponse.json({ success: true, stats }, { headers: { 'Cache-Control': 'no-store' } })
}
