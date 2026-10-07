// RD-CHECKIN-2.0 — the ONE resolver that decides whether an event is operationally
// available for check-in.
//
// ═══ THE DIVERGENCE THIS CLOSES ══════════════════════════════════════════════
// The audit found seven check-in surfaces answering "is this event open?" in four
// different ways. The landing page listed an event from the organizer's DRAFT
// (`users/{uid}/eventDrafts/{id}.status === 'published'`), while the routes behind
// its buttons additionally consulted the PUBLIC document
// (`events/{slug}.lifecycleStatus`, plus moderation takedown). The two can disagree:
// a cancelled, archived or moderated event still has a published draft. The operator
// saw "Open Check-in" and the server said "not accepting check-ins".
//
// Both reads are legitimate and neither can be dropped — the draft proves OWNERSHIP
// and yields the slug, the public document carries the LIFECYCLE. What was missing
// was a single place that performs both, in one order, and returns one verdict. Every
// check-in surface now calls this, so the button and the route cannot disagree.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// Not authorization. Whether the CALLER may act on the event is decided by
// authorizeEvent / isEventSlugInScope before this is reached, and `workspaceUid`
// must already be a server-resolved value. This answers only "is the event itself
// open for business", and it deliberately reads the same two documents the existing
// routes read — no new trust path, no new collection.

import { adminDb }                from '@/lib/firebase/admin'
import { getEventCheckInStatus }  from '@/lib/checkin/eventStatus'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'

/**
 * Why an event is unavailable. `unavailable` deliberately does not distinguish
 * "does not exist in your workspace" from "exists but is closed" at the API
 * boundary for a gate caller — but the resolver DOES distinguish them internally so
 * the organizer-facing surfaces can say something useful.
 */
export type CheckinBlockedReason =
  | 'not_found'          // no such event in this workspace
  | 'not_published'      // draft exists but was never published
  | 'no_slug'            // published draft with no resolvable public slug (data defect)
  | 'not_accepting'      // public document says cancelled / archived / drafted / taken down

export type CheckinReadiness =
  | { ok: true;  eventId: string; eventSlug: string; eventName: string }
  | { ok: false; eventId: string; eventSlug: string | null; eventName: string | null; reason: CheckinBlockedReason }

/** Human wording for a blocked event. One vocabulary across every surface. */
export const CHECKIN_BLOCKED_COPY: Record<CheckinBlockedReason, string> = {
  not_found:     'Event not found.',
  not_published: 'This event has not been published yet.',
  no_slug:       'This event has no public address yet.',
  not_accepting: 'This event is not accepting check-ins.',
}

/**
 * Is this event open for check-in, and what is its slug and name?
 *
 * `workspaceUid` MUST be a server-resolved workspace (authz.workspaceUid), never a
 * client-supplied uid: the draft path is built from it, so a caller-controlled value
 * here would read another organizer's event.
 *
 * Two reads, both of which the check-in routes already performed separately:
 *   1. `users/{workspaceUid}/eventDrafts/{eventId}` — ownership, publication, slug
 *   2. `events/{slug}`                              — lifecycle + moderation takedown
 */
export async function resolveCheckinReadiness(
  workspaceUid: string,
  eventId:      string,
): Promise<CheckinReadiness> {
  const snap = await adminDb.doc(`users/${workspaceUid}/eventDrafts/${eventId}`).get()
  if (!snap.exists) {
    return { ok: false, eventId, eventSlug: null, eventName: null, reason: 'not_found' }
  }

  const draft   = snap.data() as Record<string, unknown>
  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info as Record<string, unknown>) ?? {}
  const name    = typeof info.name === 'string' && info.name ? info.name : 'Event'
  // RD-CE-FIX C1 · only a slug the live document proves is THIS workspace's event for THIS draft.
  const slug    = await resolveOwnedEventSlug(workspaceUid, eventId, draft)

  if (draft.status !== 'published') {
    return { ok: false, eventId, eventSlug: slug, eventName: name, reason: 'not_published' }
  }
  if (!slug) {
    return { ok: false, eventId, eventSlug: null, eventName: name, reason: 'no_slug' }
  }

  const status = await getEventCheckInStatus(slug)
  if (status !== 'ok') {
    // `not_found` from the public document means the draft says published but no
    // public event exists — from a gate's point of view that is indistinguishable
    // from closed, and saying so is more useful than exposing the inconsistency.
    return { ok: false, eventId, eventSlug: slug, eventName: name, reason: 'not_accepting' }
  }

  return { ok: true, eventId, eventSlug: slug, eventName: name }
}

/**
 * The same verdict for a surface that already knows the slug and has already proved
 * ownership another way (the scan path resolves the registration first, and the
 * registration carries both `organizerUid` and `eventSlug`).
 *
 * It is deliberately the SAME lifecycle call, so there is one rule about which
 * lifecycle states admit people, in one file.
 */
export async function isEventOpenForCheckin(eventSlug: string): Promise<boolean> {
  return (await getEventCheckInStatus(eventSlug)) === 'ok'
}
