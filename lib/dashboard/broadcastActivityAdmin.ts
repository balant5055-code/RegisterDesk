// RD-DASH-09 · the Firestore side of Recent broadcasts. READ-ONLY.
//
// Split from ./broadcastActivity so the shaping and ordering rules stay testable without
// booting the Admin SDK — the same pure/IO split dailyStats, communicationUsage and
// dailyStatsAdmin already use in this folder.
//
// ═══ READ COST ═══════════════════════════════════════════════════════════════
// ONE query, `limit(BROADCAST_ROWS_SHOWN + 1)` — six documents to render five and know
// whether a sixth exists. Never a collection scan, never a per-campaign read.
//
// ═══ SCOPE IS SERVER-SIDE, ALWAYS ════════════════════════════════════════════
// `organizerUid` is on every query, and `eventSlug` joins it whenever an event is selected.
// Nothing is filtered on the client: a client-side narrowing would mean another organizer's
// campaigns had already crossed the wire.

import { adminDb } from '@/lib/firebase/admin'
import {
  BROADCAST_ROWS_SHOWN, rankBroadcasts, toBroadcastRow,
  type BroadcastActivity, type RawBroadcast,
} from './broadcastActivity'

/** Firestore Timestamp → ISO, defensively. Anything unrecognised becomes null, never `now`. */
function iso(v: unknown): string | null {
  if (!v) return null
  const t = v as { toDate?: () => Date }
  if (typeof t.toDate === 'function') {
    const d = t.toDate()
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof v === 'string') return v
  return null
}

/**
 * READ-ONLY. The most recent broadcasts for this scope, newest send first.
 *
 * `scope.scoped` is an INTENTION, not a slug that might be missing — an event can be selected
 * while still unpublished, and an unpublished event has no slug. Passing that null through
 * would drop the event filter and list the whole workspace's broadcasts under one event's
 * name. Same guard, same reason, as RD-DASH-06 and RD-DASH-07.
 */
export async function readBroadcastActivity(
  uid: string,
  scope: { scoped: boolean; slug: string | null },
): Promise<BroadcastActivity> {
  const { scoped, slug } = scope

  // A campaign cannot exist without an eventSlug, so an event that has none can have no
  // broadcasts. That is a PROVEN empty, not an unread one — and not the workspace's list.
  if (scoped && !slug) {
    return { rows: [], hasMore: false, unavailable: false, orderedByCreation: false }
  }

  const base = () => {
    const q = adminDb.collection('broadcastCampaigns').where('organizerUid', '==', uid)
    return slug ? q.where('eventSlug', '==', slug) : q
  }
  const take = BROADCAST_ROWS_SHOWN + 1

  const shape = (snap: FirebaseFirestore.QuerySnapshot, orderedByCreation: boolean): BroadcastActivity => {
    const all = snap.docs.map(d => {
      const x = d.data() as Record<string, unknown>
      const raw: RawBroadcast = {
        id: d.id,
        subject: x.subject, channel: x.channel, status: x.status,
        recipientCount: x.recipientCount, successCount: x.successCount, failCount: x.failCount,
        sentAt: iso(x.sentAt), scheduledFor: iso(x.scheduledFor), createdAt: iso(x.createdAt),
        eventName: x.eventName, eventSlug: x.eventSlug,
      }
      return toBroadcastRow(raw)
    })
    // Re-ranked in memory as well as in the query: the fallback path below orders by a
    // different field, and the card must present one order regardless of how it got here.
    const ranked = rankBroadcasts(all)
    return {
      rows: ranked.slice(0, BROADCAST_ROWS_SHOWN),
      hasMore: ranked.length > BROADCAST_ROWS_SHOWN,
      unavailable: false,
      orderedByCreation,
    }
  }

  try {
    // `sentAt` is the send time and is NOT interchangeable with `createdAt` — see the note in
    // ./broadcastActivity. Needs (organizerUid[, eventSlug], sentAt DESC); both are DECLARED
    // in firestore.indexes.json and neither is deployed yet.
    return shape(await base().orderBy('sentAt', 'desc').limit(take).get(), false)
  } catch {
    try {
      // DISCLOSED degradation, not a silent one. The workspace `createdAt` index exists, so
      // the card still works — and it prints a note saying the order is by creation, because
      // on real data those two orderings differ at the very first row.
      return shape(await base().orderBy('createdAt', 'desc').limit(take).get(), true)
    } catch {
      // Both failed. An empty list here would read as "you have sent no broadcasts", which is
      // a statement about the workspace rather than about the query.
      return { rows: [], hasMore: false, unavailable: true, orderedByCreation: false }
    }
  }
}
