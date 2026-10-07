// ─── Where a completed event can actually take you ───────────────────────────
//
// The Recently Completed card offers three destinations. This module answers, per slug, which
// of them are real — READ-ONLY and additive; it changes no existing query and no lifecycle
// rule.
//
// ═══ THE QUESTION IS "DOES THE PAGE EXIST", NOT "DOES IT HAVE CONTENT" ═══════
// An earlier revision asked the second question and got the product wrong. It hid "Photos"
// whenever a gallery held zero published images — but /events/<slug>/gallery answers 200 and
// renders "No photos have been published yet", which is a destination, not a dead link.
// Hiding it meant the reader could never reach the gallery of an event that had not published
// yet, and the card showed a single action on the only completed event the product has.
//
// So the rule is now the PAGE'S OWN 404 CONDITION, and nothing stricter:
//
//   /events/<slug>/gallery   404s when `resolvePublicEvent` returns null — the event is
//                            unresolvable, taken down, not publicly visible, missing the
//                            uid/draftId bridge, or public galleries are switched off.
//                            An EMPTY gallery is a 200, so it is offered.
//
//   /results/<slug>          404s when the event fails the public gate. It used to 404 for a
//                            public event with no live snapshot too; that was fixed in
//                            app/results/[eventSlug]/page.tsx, which now renders "Results
//                            aren't published yet" for exactly that case.
//
//   /events/<slug>/certificates
//                            The ONE destination where "the page renders" is not the right
//                            test. It 404s only on an unknown slug, so it would open for any
//                            event — but what it opens is a LOOKUP FORM, and a lookup against
//                            an event with no certificates answers "nothing found" only after
//                            the attendee has typed their email, bib or ticket code. An empty
//                            gallery says so immediately; this wastes the reader's input
//                            first. So it is gated on the data the lookup itself queries: at
//                            least one generated certificate record for the slug.
//
// Both are still CHECKED rather than assumed. A completed event whose gallery bridge is
// missing genuinely 404s, and that link stays hidden.
//
// ═══ IT NEVER THROWS ═════════════════════════════════════════════════════════
// A failure here must never take down the homepage, and must never produce a link. Every
// lookup is caught and degrades to `null`, which the card reads as "do not offer this".
// The worst outcome is a card with fewer actions; there is no path to a broken one.
//
// ═══ COST ════════════════════════════════════════════════════════════════════
// One cached event read per slug, plus one existence probe on `certificates`. Both checks go through `getEventBySlug`, which is wrapped
// in React `cache()`, so the two questions about one event share a single read — and the
// snapshot query the previous revision needed is gone entirely. The homepage holds at most
// four completed cards and is ISR with a 60-second revalidate, so this runs about once a
// minute for the whole site rather than per visitor.

import { adminDb } from '@/lib/firebase/admin'
import { resolvePublicEvent } from '@/features/public-gallery/services/publicGalleryService'
import { COLLECTIONS as CERT } from '@/lib/certificates/constants'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { isContentTakenDown } from '@/lib/admin/moderation'
import { detailsOnly, type CompletedDestinationMap } from '@/lib/discovery/completedDestinations'

// The TYPES and `detailsHref` live in lib/discovery/completedDestinations — a pure module —
// because the card imports them, and importing them from here dragged firebase-admin into
// every render of that card, tests included.
export type { CompletedEventDestinations, CompletedDestinationMap } from '@/lib/discovery/completedDestinations'

/**
 * Is the event one the public may see at all?
 *
 * The same three checks app/events/[slug] and app/results/[eventSlug] both apply, in the same
 * order. `getEventBySlug` is React-cached, so asking here and asking again while rendering
 * the results page costs one read.
 */
async function isPubliclyVisible(slug: string): Promise<boolean> {
  try {
    const event = await getEventBySlug(slug)
    if (!event) return false
    if (!canExposePublicEvent(event.lifecycleStatus)) return false
    if (isContentTakenDown(event.moderationStatus)) return false
    return true
  } catch (err) {
    console.error(`[completedEventDestinations] event lookup failed for ${slug}:`, err)
    return false
  }
}

/**
 * Does /events/<slug>/gallery render, rather than 404?
 *
 * `resolvePublicEvent` IS that page's gate — it is the function whose null result becomes the
 * notFound() call. Asking it directly means the card and the page can never disagree, and it
 * costs one cached event read. What it deliberately does NOT do any more is count photos: an
 * empty gallery is a page with an empty state, and hiding the way to it helped nobody.
 */
async function hasGalleryDestination(slug: string): Promise<boolean> {
  try {
    return (await resolvePublicEvent(slug)) !== null
  } catch (err) {
    console.error(`[completedEventDestinations] gallery lookup failed for ${slug}:`, err)
    return false
  }
}

/**
 * Has this event generated at least one certificate?
 *
 * The same collection and the same `eventSlug` equality the Certificate Center's own lookup
 * runs (app/api/events/[slug]/certificates/lookup) — so the card cannot offer a lookup that
 * the lookup itself could never satisfy.
 *
 * `limit(1).select()` asks only whether a document exists: no certificate fields cross the
 * wire, and the cost does not grow with an event that issued ten thousand of them.
 */
async function hasCertificates(slug: string): Promise<boolean> {
  try {
    const snap = await adminDb.collection(CERT.CERTIFICATES)
      .where('eventSlug', '==', slug)
      .select()
      .limit(1)
      .get()
    return !snap.empty
  } catch (err) {
    // A missing index or a transient failure must never fabricate availability.
    console.error(`[completedEventDestinations] certificate lookup failed for ${slug}:`, err)
    return false
  }
}

/**
 * Resolve every completed card's destinations in one pass.
 *
 * Returns an entry for every slug it was given, so the caller never has to handle a missing
 * key — an event with nothing extra to offer gets `{ details, results: null, photos: null }`.
 */
export async function resolveCompletedDestinations(
  slugs: readonly string[],
): Promise<CompletedDestinationMap> {
  const unique = [...new Set(slugs.filter(Boolean))]
  const map: CompletedDestinationMap = {}
  for (const slug of unique) map[slug] = detailsOnly(slug)
  if (unique.length === 0) return map

  const [galleryFlags, publicFlags, certFlags] = await Promise.all([
    Promise.all(unique.map(hasGalleryDestination)),
    Promise.all(unique.map(isPubliclyVisible)),
    Promise.all(unique.map(hasCertificates)),
  ])

  unique.forEach((slug, i) => {
    if (galleryFlags[i]) map[slug].photos       = `/events/${slug}/gallery`
    if (publicFlags[i])  map[slug].results      = `/results/${slug}`
    if (certFlags[i])    map[slug].certificates = `/events/${slug}/certificates`
  })
  return map
}
