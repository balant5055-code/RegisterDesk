// RD-ATTENDEE-01 Phase 1 (A): the ONE canonical builder for the public registration
// URL. Every registration entry point (pass card, hero deep-link, login redirect,
// pass-picker) must use this so the route (/events/[slug]/register) and the query
// parameter (passId) can never drift again. Historically some templates hand-wrote
// `/e/${slug}/register?pass=` — a non-existent route + wrong param — which 404'd the
// purchase path; this helper is the single source that prevents that.
/**
 * RD-EVENT-46 — the ONE canonical builder for a public event page URL.
 *
 * The publish success screen hand-wrote `/e/${slug}`, which is not a route: the public page
 * is `app/events/[slug]`. Organizers who published then copied the link received a 404. That
 * is the SAME wrong prefix this module's registration helper was created to eliminate — it
 * simply survived in a second place. Adding the sibling builder here means the event page and
 * its registration path can never drift apart again.
 */
export function buildEventHref(slug: string): string {
  return `/events/${slug}`
}

export function buildRegisterHref(slug: string, passId?: string | null): string {
  const base = `${buildEventHref(slug)}/register`
  return passId ? `${base}?passId=${encodeURIComponent(passId)}` : base
}
