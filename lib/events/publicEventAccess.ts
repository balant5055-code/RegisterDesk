// ─── The one public-event boundary ───────────────────────────────────────────
//
// Answers a single question for every public event route: does this slug resolve to an
// event the public may see? Before this existed, five routes each answered it their own
// way and three of them got it wrong.
//
// ═══ WHAT THE ROUTES USED TO DO ══════════════════════════════════════════════
//   /events/[slug]              getEventBySlug + both gates          ← correct
//   /events/[slug]/gallery      resolvePublicEvent (both gates)      ← correct
//   /events/[slug]/photos       getEventBySlug, existence ONLY       ← leaked
//   /events/[slug]/register     getEventBySlug, existence ONLY       ← leaked
//   /events/[slug]/certificates a raw adminDb doc read, existence ONLY ← leaked a TITLE
//
// getEventBySlug is a bare document read — it back-fills legacy fields and returns ANY
// event, draft or taken-down. Every gate is the caller's job, and three callers did not
// know that. A draft or admin-taken-down event therefore stayed reachable on /photos,
// /register and /certificates while its own detail page correctly 404'd, and the
// certificates route published the event's NAME through an inline Firestore read.
//
// ═══ THE BOUNDARY ════════════════════════════════════════════════════════════
//   exists?  → no  → 404
//   canExposePublicEvent(lifecycleStatus)?  → no  → 404   (draft, archived, unknown states)
//   isContentTakenDown(moderationStatus)?   → yes → 404
//   otherwise → visible
//
// ═══ WHY `visibility: 'private'` IS NOT A GATE ═══════════════════════════════
// Deliberate, and it would be a product regression to add it. A private event is
// INVITE-ONLY, not hidden: it stays reachable by its link because that is how invitees
// register at all. It is withheld from discovery listings and the sitemap, and its detail
// page sets `robots: noindex, nofollow`. Gating on it here would 404 every invited guest.
// Lifecycle and moderation are the real public boundary; visibility governs listing.
//
// ═══ WHY notFound() BELONGS IN generateMetadata ══════════════════════════════
// `app/events/[slug]/loading.tsx` puts a Suspense boundary on the segment AND every nested
// segment. Next flushes the shell — HTTP 200 and the skeleton — before the async page body
// resolves, so a notFound() thrown in the body can only swap the UI inside a stream whose
// status is already committed. That is why every one of these routes answered 200 with
// "Event not found" in the body, while /results and /tickets — which have no ancestor
// loading.tsx — returned a correct 404 from the identical call.
//
// generateMetadata resolves before that first flush, so `requirePublicEvent` throws there
// and the status is a real 404. The loading skeletons stay exactly as they are for events
// that do exist; nothing was deleted to make the status work.

import { notFound } from 'next/navigation'
import { getEventBySlug, type PublishedEvent } from '@/lib/firebase/firestore/events'
import { isPubliclyViewable } from '@/lib/events/publicEventGate'

// Re-exported so a route needs ONE import for the boundary, whichever shape it wants.
export { isPubliclyViewable }

/**
 * The event if the public may see it, otherwise null. For callers that need to branch
 * rather than 404 — a metadata function that wants a fallback title, for instance.
 *
 * Reuses getEventBySlug, which is React.cache()-wrapped: calling this in generateMetadata
 * and again in the page body costs ONE Firestore read per request, not two.
 */
export async function findPublicEvent(slug: string): Promise<PublishedEvent | null> {
  const event = await getEventBySlug(slug)
  return isPubliclyViewable(event) ? event : null
}

/**
 * The event, or a real HTTP 404.
 *
 * Call this from generateMetadata — see the note above about the streaming boundary. In a
 * page body it still renders the right UI, but the status will already have been sent.
 */
export async function requirePublicEvent(slug: string): Promise<PublishedEvent> {
  const event = await findPublicEvent(slug)
  if (!event) notFound()
  return event
}
