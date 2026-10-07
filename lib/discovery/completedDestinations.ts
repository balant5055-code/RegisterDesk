// ─── Where a completed event can take you — the PURE half ────────────────────
//
// Types and the one href that needs no lookup. Deliberately free of any Firestore import:
// CompletedEventCard is a server component but it is rendered in tests with
// renderToStaticMarkup, and pulling `lib/firebase/admin` in through a type import was enough
// to make firebase-admin parse a stubbed service-account key and throw before a single
// assertion ran.
//
// The lookups live beside the database, in lib/firebase/firestore/completedEventDestinations.

/**
 * The destinations a single completed event actually has.
 *
 * `details` is never null: every event this describes came out of
 * `listRecentlyCompletedEvents`, which has already applied the moderation, visibility and
 * archive gates the detail page applies — so /events/<slug> resolves by construction.
 *
 * `results` and `photos` are null unless proven otherwise. Both of their routes call
 * notFound() when the underlying data is absent, so "unknown" and "missing" must produce
 * the same outcome: no link.
 */
export interface CompletedEventDestinations {
  details: string
  results: string | null
  photos:  string | null
  /**
   * /events/<slug>/certificates — the Event Day Certificate Center.
   *
   * Null unless the event has at least one GENERATED certificate record. The page itself
   * 404s only on an unknown slug, so it would render for any event — but what it renders is
   * a lookup form, and a lookup against an event with no certificates can only ever answer
   * "nothing found" after the attendee has typed their email or bib. That is a worse dead
   * end than an empty state, so this one is gated on the data the lookup actually queries.
   */
  certificates: string | null
}

/** Slug → destinations. Keyed by slug so the card needs no index arithmetic. */
export type CompletedDestinationMap = Record<string, CompletedEventDestinations>

/** The canonical public event page. The ONLY href here that needs no availability check. */
export function detailsHref(slug: string): string {
  return `/events/${slug}`
}

/** The card's fallback: details alone, for any caller that could not resolve the rest. */
export function detailsOnly(slug: string): CompletedEventDestinations {
  return { details: detailsHref(slug), results: null, photos: null, certificates: null }
}
