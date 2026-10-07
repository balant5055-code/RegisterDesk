// Resolve + ownership-check an organizer event by its draftId ([eventId] in routes).
// Mirrors the existing event-scoped route pattern: the event lives at
// users/{workspaceUid}/eventDrafts/{eventId}; the public slug is in eventDetails.seo.urlSlug.

import { adminDb } from '@/lib/firebase/admin'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

export interface OwnedEvent {
  slug: string
  eventName: string
  /**
   * RD-EVENT-17 · the event's lifecycle, from the SAME document the slug comes from.
   *
   * Carried so the sessions route can refuse a schedule WRITE on a cancelled or archived
   * event — it had no lifecycle check at all, so a session could be added to an event
   * that no longer runs. Costs nothing: this snapshot was already read.
   */
  lifecycleStatus: string | null
}

/**
 * RD-EVENT-17 · the caller's OWN event, which simply has no public address yet.
 *
 * Sessions are keyed by `eventSlug`, which an event gets at publish, so an unpublished
 * draft genuinely cannot hold a schedule. That is a STATE, not a failure — it used to
 * collapse into the same `null` as "no such event", and the Conference tab rendered "The
 * schedule couldn't be loaded" on a perfectly healthy draft.
 */
export const UNPUBLISHED = 'unpublished' as const
export type ResolvedEvent = OwnedEvent | typeof UNPUBLISHED | null

export async function resolveOwnedEvent(workspaceUid: string, eventId: string): Promise<ResolvedEvent> {
  // `adminDb.doc()` throws on a path with the wrong number of segments, so an eventId
  // like `..%2F..%2Fadmin` would escape as an unhandled 500 carrying a Next digest. An id
  // that cannot name a document cannot name an event the caller owns.
  let snap
  try {
    snap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  } catch {
    return null
  }
  if (!snap.exists) return null
  const d = snap.data() as {
    lifecycleStatus?: unknown
    eventDetails?: { seo?: { urlSlug?: unknown }; info?: { name?: unknown } }
  }
  // RD-CE-FIX C1 · only a slug the live document proves is THIS workspace's event for THIS draft.
  const slug = await resolveOwnedEventSlug(workspaceUid, eventId, d as Record<string, unknown>)
  // The draft EXISTS and is the caller's — it just has no (verified) live event yet.
  if (!slug) return UNPUBLISHED
  const name = typeof d.eventDetails?.info?.name === 'string' ? d.eventDetails.info.name : 'Event'
  return {
    slug,
    eventName: name,
    lifecycleStatus: typeof d.lifecycleStatus === 'string' ? d.lifecycleStatus : null,
  }
}
