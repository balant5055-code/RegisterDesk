// RD-ATTENDEE-01 Phase 1 (A): the ONE canonical builder for the public registration
// URL. Every registration entry point (pass card, hero deep-link, login redirect,
// pass-picker) must use this so the route (/events/[slug]/register) and the query
// parameter (passId) can never drift again. Historically some templates hand-wrote
// `/e/${slug}/register?pass=` — a non-existent route + wrong param — which 404'd the
// purchase path; this helper is the single source that prevents that.
export function buildRegisterHref(slug: string, passId?: string | null): string {
  const base = `/events/${slug}/register`
  return passId ? `${base}?passId=${encodeURIComponent(passId)}` : base
}
