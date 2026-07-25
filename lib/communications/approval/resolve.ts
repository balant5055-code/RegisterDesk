// RD-PLATFORM-COMMS-02 Phase 5D — the canonical Campaign Approval resolver (server).
//
// Reads the campaign (via the canonical Campaign Registry) + its approval record, then runs the
// ONE pure resolver (./normalize) which uses the ONE state machine. READ-ONLY — it queries and
// projects; it never performs a transition, writes, executes, schedules, or sends.

import { adminDb } from '@/lib/firebase/admin'
import { resolveCampaigns } from '@/lib/communications/campaigns/resolve'
import { normalizeApproval, resolveApproval } from './normalize'
import type { ResolvedApproval } from './types'

function tsToIso(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') return (ts as { toDate: () => Date }).toDate().toISOString()
  return typeof ts === 'string' ? ts : ''
}

/** Resolve the approval view for a campaign (read-only). */
export async function resolveCampaignApproval(campaignId: string): Promise<ResolvedApproval> {
  // Campaign via the canonical registry (read-only). Empty collection ⇒ campaign is null.
  const campaigns = await resolveCampaigns({ limit: 500 })
  const campaign  = campaigns.find(c => c.campaignId === campaignId) ?? null

  // Approval record (read-only). No writer yet ⇒ typically absent.
  const snap = await adminDb.collection('campaignApprovals').where('campaignId', '==', campaignId).limit(1).get()
  const approval = snap.empty ? null : (() => {
    const doc = snap.docs[0]
    const d = doc.data() as Record<string, unknown>
    return normalizeApproval({
      ...d, id: doc.id,
      submittedAt: d.submittedAt ? tsToIso(d.submittedAt) : null,
      reviewedAt:  d.reviewedAt  ? tsToIso(d.reviewedAt)  : null,
      approvedAt:  d.approvedAt  ? tsToIso(d.approvedAt)  : null,
      rejectedAt:  d.rejectedAt  ? tsToIso(d.rejectedAt)  : null,
      cancelledAt: d.cancelledAt ? tsToIso(d.cancelledAt) : null,
      archivedAt:  d.archivedAt  ? tsToIso(d.archivedAt)  : null,
    })
  })()

  return resolveApproval(campaign ? { campaignId: campaign.campaignId, name: campaign.name } : null, approval)
}
