// RD-PLATFORM-COMMS-02 Phase 5A — the canonical Campaign Registry resolver (server).
//
// Reads the platformCampaigns collection and normalizes each record through the ONE pure
// resolver (./normalize). READ-ONLY — it queries and shapes; it never writes, schedules,
// executes, or sends. The collection has no writer yet (the Composer is a future phase), so
// this returns [] until campaigns are created. No campaign is fabricated.

import { adminDb } from '@/lib/firebase/admin'
import { normalizeCampaign, resolveCampaign } from './normalize'
import type { ResolvedCampaign, CampaignStatus, CampaignType, CampaignCategory } from './types'

export interface CampaignFilters {
  status?:   CampaignStatus
  type?:     CampaignType
  category?: CampaignCategory
  search?:   string
  limit?:    number
}

function tsToIso(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') return (ts as { toDate: () => Date }).toDate().toISOString()
  return typeof ts === 'string' ? ts : ''
}

/** Resolve the campaign registry (read-only). */
export async function resolveCampaigns(filters: CampaignFilters = {}): Promise<ResolvedCampaign[]> {
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500)

  let query = adminDb.collection('platformCampaigns').orderBy('createdAt', 'desc') as FirebaseFirestore.Query
  if (filters.status)   query = query.where('status', '==', filters.status)
  if (filters.type)     query = query.where('type', '==', filters.type)
  if (filters.category) query = query.where('category', '==', filters.category)

  const snap = await query.limit(limit).get()

  let campaigns = snap.docs
    .map(doc => {
      const d = doc.data() as Record<string, unknown>
      // Normalize Firestore timestamps to ISO before the pure normalizer runs.
      return normalizeCampaign({
        ...d, id: doc.id,
        createdAt:   tsToIso(d.createdAt), updatedAt: tsToIso(d.updatedAt),
        scheduledAt: d.scheduledAt ? tsToIso(d.scheduledAt) : null,
        startedAt:   d.startedAt   ? tsToIso(d.startedAt)   : null,
        completedAt: d.completedAt ? tsToIso(d.completedAt) : null,
        cancelledAt: d.cancelledAt ? tsToIso(d.cancelledAt) : null,
      })
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .map(resolveCampaign)

  const term = filters.search?.trim().toLowerCase()
  if (term) campaigns = campaigns.filter(c => `${c.name} ${c.description}`.toLowerCase().includes(term))

  return campaigns
}
