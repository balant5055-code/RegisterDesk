// RD-COMMS-L2 · What an event's broadcasts hold from — and have given back to — its WhatsApp
// capacity. Server-only, READ-ONLY. The ONE source for "In progress" and "Returned" on Usage and
// License & Services (lib/communications/capacityFigures).
//
// Only campaigns funded by THIS event's capacity carry `allowanceDraftId` (billing sets it when
// it takes the units), so the key is exactly "funded by this event". Equality-only filters with
// sum aggregations: served by single-field indexes, unbounded (no scan cap), 3 aggregation reads.
// ONE sum per query on purpose: a query with several aggregations counts only documents that hold
// EVERY aggregated field, so a settled campaign without `unknownHeldUnits` would drop its
// `refundedUnits` from the sum.
//
//   in progress = Σ allowanceUnits   of campaigns still `billingSettlement: 'pending'`
//               + Σ unknownHeldUnits of settled campaigns (outcome not confirmed yet)
//   returned    = Σ refundedUnits    of settled campaigns (net of late acceptances)

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { CapacityActivity } from './capacityFigures'

const sum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)

export async function readWhatsAppCapacityActivity(organizerUid: string, draftId: string): Promise<CapacityActivity> {
  const funded = adminDb.collection('broadcastCampaigns')
    .where('organizerUid', '==', organizerUid).where('allowanceDraftId', '==', draftId)
  const settled = funded.where('billingSettlement', '==', 'settled')
  const [sending, held, returned] = await Promise.all([
    funded.where('billingSettlement', '==', 'pending').aggregate({ s: AggregateField.sum('allowanceUnits') }).get(),
    settled.aggregate({ s: AggregateField.sum('unknownHeldUnits') }).get(),
    settled.aggregate({ s: AggregateField.sum('refundedUnits') }).get(),
  ])
  return {
    inProgress: sum(sending.data().s) + sum(held.data().s),
    returned:   sum(returned.data().s),
  }
}
