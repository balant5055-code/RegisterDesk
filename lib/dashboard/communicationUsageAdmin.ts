// RD-DASH-06 · the Firestore side of Communication usage. READ-ONLY.
//
// Split from ./communicationUsage so the derivation rules stay testable without booting the
// Admin SDK — the same pure/IO split dailyStats and dailyStatsAdmin already use in this
// folder. Nothing here decides anything; it reads seven aggregates and hands them to the
// pure resolver.
//
// Every query below was VERIFIED against production during the RD-DASH-06 audit. That
// matters, because the three aggregates this replaced were all failing on missing composite
// indexes and reporting the failure as 0.

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  resolveCommunicationUsage,
  type CommCount,
  type CommunicationUsage,
} from './communicationUsage'

/** `count()` that resolves to null instead of throwing. A failure must stay distinguishable. */
async function countOrNull(q: FirebaseFirestore.Query): Promise<CommCount> {
  try {
    const n = (await q.count().get()).data().count
    return typeof n === 'number' && Number.isFinite(n) ? n : null
  } catch { return null }
}

/**
 * READ-ONLY. Seven indexed aggregates; none transfers a document, all are O(1) in volume.
 *
 * Scope follows the Event Selector: `slug` narrows every query to that event, exactly as
 * the rest of the dashboard does. Passing null reads the whole workspace.
 */
export async function readCommunicationUsage(
  uid: string,
  scope: { scoped: boolean; slug: string | null },
): Promise<CommunicationUsage> {
  const { scoped, slug } = scope

  // ═══ THE ONE CASE A BARE SLUG CANNOT EXPRESS ════════════════════════════════
  // An event can be SELECTED while still unpublished, and an unpublished event has no
  // public slug. Passing that null straight through would drop every filter and read the
  // WHOLE WORKSPACE's send volume — then print it under that one event's name. That is the
  // exact class of defect this card was rebuilt to remove, so scope is passed as an
  // intention rather than as a slug that might be missing.
  //
  // Zero here is PROVEN, not assumed: every emailLogs and broadcastCampaigns row carries an
  // eventSlug, so an event that has no slug cannot have a row attributed to it. Nothing was
  // logged against it, and that is a measurement rather than a fallback.
  if (scoped && !slug) {
    return resolveCommunicationUsage({
      loggedTotal: 0, whatsapp: 0, delivered: 0, accepted: 0, failed: 0, campaigns: 0, reached: 0,
    })
  }

  const logs  = () => {
    const q = adminDb.collection('emailLogs').where('organizerUid', '==', uid)
    return slug ? q.where('eventSlug', '==', slug) : q
  }
  const camps = () => {
    const q = adminDb.collection('broadcastCampaigns').where('organizerUid', '==', uid)
    return slug ? q.where('eventSlug', '==', slug) : q
  }
  const SENT_CAMPAIGNS = ['sent', 'partial'] as const

  const [loggedTotal, whatsapp, delivered, accepted, failedAll, timedOut, campaigns, reached] = await Promise.all([
    countOrNull(logs()),
    countOrNull(logs().where('channel', '==', 'whatsapp')),
    countOrNull(logs().where('status', '==', 'delivered')),
    countOrNull(logs().where('status', '==', 'sent')),
    countOrNull(logs().where('status', '==', 'failed')),
    // RD-INTEG — a timed-out send is logged 'failed' with deliveryUnknown: delivery is UNKNOWN,
    // not failed, so it is taken out of the Failed figure (the analytics module does the same).
    countOrNull(logs().where('status', '==', 'failed').where('deliveryUnknown', '==', true)),
    countOrNull(camps().where('status', 'in', SENT_CAMPAIGNS)),
    // Needs (organizerUid, status, successCount) — an aggregation index must carry the
    // SUMMED field. Declared in firestore.indexes.json; until it is deployed this resolves
    // to null and the surface omits the figure rather than printing 0 recipients.
    (async (): Promise<CommCount> => {
      try {
        const v = (await camps().where('status', 'in', SENT_CAMPAIGNS)
          .aggregate({ reached: AggregateField.sum('successCount') }).get()).data().reached
        return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null
      } catch { return null }
    })(),
  ])

  const failed: CommCount = failedAll === null || timedOut === null ? null : Math.max(0, failedAll - timedOut)
  return resolveCommunicationUsage({ loggedTotal, whatsapp, delivered, accepted, failed, campaigns, reached })
}
