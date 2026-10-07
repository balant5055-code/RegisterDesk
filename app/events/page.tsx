// ─── /events — compatibility redirect to the canonical landing ───────────────
//
// `/` is the RegisterDesk event-discovery experience. This route used to render a second,
// separate marketplace UI; that page and everything built only for it have been removed.
//
// The URL is NOT retired. It stays a live public contract: the header's "Discover Events"
// deliberately points here rather than at `/`, so any link, bookmark or index entry that
// already says /events keeps working and lands in the same place. That indirection is the
// point of this file.
//
// ═══ WHY THE PAGE FILE AND NOT next.config ═══════════════════════════════════
// A redirect declared in next.config.ts is matched by the proxy before routing, and the
// patterns that catch `/events` are one careless character away from also catching
// `/events/:slug` — which would take down every event detail page, its registration flow
// and its success and sponsor routes. Declaring it HERE means the App Router has already
// resolved the segment: this file serves exactly `/events`, and `/events/[slug]/**` is a
// different route that never reaches it. The blast radius is one path by construction.
//
// ═══ 307 AND NOT 308 ═════════════════════════════════════════════════════════
// `redirect()` answers 307 (temporary). `permanentRedirect()` would answer 308 and let
// search engines fold /events' ranking signals into `/` — better SEO consolidation, and
// the right call once this structure is settled. It is deliberately not used yet: a 308 is
// cached hard by browsers and intermediaries, so if /events is ever given its own page
// again, every visitor who saw the 308 would keep skipping it. Swap `redirect` for
// `permanentRedirect` (same import, same call) when the shape of the product is fixed.
//
// No metadata, no JSON-LD, no data fetch: nothing here renders, so nothing here needs to
// describe itself. The discovery metadata that used to live in this file belonged to the
// deleted page and went with it — app/page.tsx carries the canonical set.

// ═══ THE QUERY STRING TRAVELS WITH THE REDIRECT ══════════════════════════════
// The discovery page's filters live in its query string (lib/discovery/urlState.ts), and
// that module keeps a read-only `type` alias precisely so the event-page breadcrumb
// (`/events?type=sports`, built by lib/events/breadcrumbs.ts) "keeps working". It did not:
// this file answered `redirect('/')` and dropped the query, so "Sports" in a breadcrumb
// landed on the unfiltered homepage. Measured in the link crawl — /events?type=sports → /.
//
// The redirect now carries the query through. A bare /events is still exactly `/`, which
// is the contract every other consumer relies on; only a /events?… request changes, and it
// changes to the URL the discovery page already understands.

import { redirect } from 'next/navigation'

export default async function EventsRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<never> {
  const params = await searchParams
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string') qs.set(k, v)
    else if (Array.isArray(v)) for (const x of v) qs.append(k, x)
  }
  const query = qs.toString()
  redirect(query ? `/?${query}` : '/')
}
