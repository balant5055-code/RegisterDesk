// ─── / — the RegisterDesk event-discovery landing ────────────────────────────
//
// Phase 3 foundation: the shell, hero, search and browse shortcuts. A SERVER component that
// owns the data and hands presentation the results — no component below this file fetches
// anything, and only the search capsule hydrates.
//
// ONE CANONICAL SOURCE. Every event on this page comes from lib/firebase/firestore/publicEvents
// — `listPublishedEvents` for the hero and the upcoming rail, `listRecentlyCompletedEvents` for
// the completed rail. Both apply the SAME moderation-takedown, private-visibility and archive
// gates and the same registration-counter join. Reading `events` directly through adminDb here
// would bypass all of that in a single step — so it is never done.
//
// They are two functions rather than one because they answer different questions.
// `listPublishedEvents` is contractually `lifecycleStatus == 'published'` and is relied on by
// /events and GET /api/events. An event that has HAPPENED has usually left that state — for
// 'registration_closed' when registration closed, or 'completed' when the organizer completed
// it — so widening that one filter to reach it would silently change what every other caller
// returns.
//
// ═══ THIS PAGE DELIBERATELY DOES NOT READ `searchParams` ═════════════════════
// `searchParams` is a Request-time API, and a page that touches it is opted into DYNAMIC
// rendering for every request. An earlier revision of this file did read it, and the build's
// route table reported `ƒ /` instead of `○ /` — meaning the site's highest-traffic URL would
// re-query Firestore on every visit rather than being served from a 60-second prerender.
//
// Nothing here needs those values server-side: the hero's query is intentionally unfiltered,
// so the query string is read inside the search island instead (behind a Suspense boundary)
// and `/` stays static. When the filtered results section arrives, that phase decides
// deliberately whether the trade is worth making — rather than inheriting it by accident.
//
// THE QUERY IS UNFILTERED ON PURPOSE. Facets computed from an already-filtered response
// collapse to whatever that filter returned, which is the defect the data layer's own
// comments record having fixed once (D-H1). The location pickers therefore read the general
// pool, and the results phase will carry its own query.
//
// THE REJECTION IS RETHROWN, never swallowed. This page is ISR, so a render that SUCCEEDS is
// written to the page cache and served to everyone until the next revalidation — turning one
// transient Firestore blip into an empty landing page for the whole window. A render that
// throws is not cached, so the last good page keeps being served and the next request retries.

import type { Metadata } from 'next'
import { listPublishedEvents, listRecentlyCompletedEvents } from '@/lib/firebase/firestore/publicEvents'
import { resolveCompletedDestinations } from '@/lib/firebase/firestore/completedEventDestinations'
import type { CompletedDestinationMap } from '@/lib/discovery/completedDestinations'
import { facetCounts } from '@/components/discovery/lib/collection'
import { buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'
import { HomeShell } from '@/components/discovery/home/HomeShell'
import { HomeHero } from '@/components/discovery/home/HomeHero'
import { UpcomingEvents } from '@/components/discovery/home/UpcomingEvents'
import { RecentlyCompleted } from '@/components/discovery/home/RecentlyCompleted'

export const revalidate = 60

/** Enough to fill the collage and give the location pickers a genuine set of facets. */
const HERO_POOL = 24

/**
 * Cards in the Recently Completed rail — a teaser, not an archive.
 *
 * It needs its OWN query rather than a slice of HERO_POOL. `listPublishedEvents` filters
 * `lifecycleStatus == 'published'`, and a finished event has usually left that state:
 * closing registrations moves it to 'registration_closed', the "Complete" action to
 * 'completed'. No page size of the published listing can surface an event it structurally
 * excludes.
 */
const COMPLETED_CARDS = 4

// The canonical URL is `/` with no query string. Because the page renders identically
// whatever the query string says, every `/?q=…` variant self-canonicalises here rather than
// becoming a thin near-duplicate in the index.
export const metadata: Metadata = buildMetadata({
  title:       'RegisterDesk — Discover events across India',
  description: 'Find conferences, workshops, sports events, cultural programmes and community meetups open for registration across India. Register in seconds.',
  path:        '/',
})

export default async function Home() {
  let data: Awaited<ReturnType<typeof listPublishedEvents>>
  try {
    data = await listPublishedEvents({ limit: HERO_POOL })
  } catch (err) {
    console.error('[/] discovery query failed:', err)
    throw err
  }

  // Deliberately NOT rethrown, unlike the query above.
  //
  // The hero and the search facets are the page; without them there is nothing to serve, so a
  // failure there must not be cached as an empty landing (see the ISR note at the top of this
  // file). The completed rail is a teaser at the foot of the page: if its one bounded query
  // fails, the right outcome is a homepage without that section, not a 500 for everyone until
  // the next revalidation.
  let completed: Awaited<ReturnType<typeof listRecentlyCompletedEvents>> = []
  try {
    completed = await listRecentlyCompletedEvents({ take: COMPLETED_CARDS })
  } catch (err) {
    console.error('[/] recently-completed query failed (section omitted):', err)
  }

  // ═══ WHICH ARCHIVE LINKS ACTUALLY EXIST ══════════════════════════════════
  // /results/<slug> and /events/<slug>/gallery both 404 when an event has no published
  // results and no public gallery, so the completed cards cannot offer them blind. This
  // resolves, per event, which destinations are real; the module never throws and degrades
  // to details-only, and the try/catch here is a second floor under that.
  //
  // It reads only for events already on the page (at most four), and `/` is ISR with a
  // 60-second revalidate, so the cost is once a minute for the whole site rather than per
  // visitor. A failure costs the extra links, never the section and never the page.
  let completedLinks: CompletedDestinationMap = {}
  try {
    completedLinks = await resolveCompletedDestinations(completed.map(e => e.slug))
  } catch (err) {
    console.error('[/] completed destination lookup failed (details links only):', err)
  }

  const cityCounts  = facetCounts(data.events, 'city')
  const stateCounts = facetCounts(data.events, 'state')

  const jsonLd = [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([{ name: 'Home', path: '/' }]),
  ]

  return (
    <>
      <HomeShell>
        <HomeHero
          cityCounts={cityCounts}
          stateCounts={stateCounts}
        />
        {/* Reuses the events already fetched above — this section costs no extra reads. */}
        <UpcomingEvents events={data.events} />
        <RecentlyCompleted events={completed} destinations={completedLinks} />
      </HomeShell>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
    </>
  )
}
