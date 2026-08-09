// Race leaderboard + search — /results/{eventSlug}/{passSlug}
//
// Server component. Cursor-paginated on overall rank via ?after= — never an offset, so
// page N costs the same as page 1 and nothing scans the collection.
// `?q=` switches the page into search mode: bib first (one document GET), then name prefix.

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ArrowRight, Users } from 'lucide-react'
import {
  LeaderboardTable, ResultsBreadcrumb, ResultsHeader, ResultsShell,
} from '@/features/race-operations/components/public/ResultsChrome'
import { ResultsSearch } from '@/features/race-operations/components/public/ResultsSearch'
import {
  LEADERBOARD_PAGE_SIZE, getLeaderboard, searchRace,
} from '@/features/race-operations/services/publicResults'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 300

type Params = {
  params:       Promise<{ eventSlug: string; passSlug: string }>
  searchParams: Promise<{ q?: string; after?: string }>
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { eventSlug, passSlug } = await params
  const board = await getLeaderboard(eventSlug, passSlug).catch(() => null)
  if (!board) return { title: 'Results not found — RegisterDesk' }

  const { race } = board
  const title = `${race.passName} Results — ${race.eventName}`
  const description =
    `Official ${race.passName} results for ${race.eventName}: `
    + `${race.finisherCount.toLocaleString('en-IN')} finishers. `
    + 'Search by bib number or runner name.'
  const url = `${BASE_URL}/results/${eventSlug}/${passSlug}`

  return {
    title, description,
    metadataBase: new URL(BASE_URL),
    // Canonical is the un-paginated, un-searched URL, so paged and searched variants do
    // not compete with it in the index.
    alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: 'RegisterDesk', title, description },
    twitter:   { card: 'summary_large_image', title, description },
  }
}

export default async function RaceLeaderboardPage({ params, searchParams }: Params) {
  const { eventSlug, passSlug } = await params
  const { q, after } = await searchParams

  const query = (q ?? '').trim()
  const afterRank = after !== undefined && Number.isFinite(Number(after)) ? Number(after) : null

  // Search mode and leaderboard mode are separate reads — a search never pages the board.
  const searching = query !== ''
  const board = searching ? null : await getLeaderboard(eventSlug, passSlug, afterRank).catch(() => null)
  const found  = searching ? await searchRace(eventSlug, passSlug, query).catch(() => null) : null

  const race = board?.race ?? found?.race
  if (!race) notFound()

  const rows = searching ? (found?.rows ?? []) : (board?.rows ?? [])
  const baseHref = `/results/${eventSlug}/${passSlug}`

  // RD-RESULTS-PUBLIC-FIX-01 · paging arithmetic, derived from the page we are on.
  // `LEADERBOARD_PAGE_SIZE` is the server's own constant, so this cannot drift from the
  // page size the query actually uses.
  const prevStart = afterRank === null ? null : afterRank - LEADERBOARD_PAGE_SIZE
  const prevHref  = prevStart !== null && prevStart > 0
    ? `${baseHref}?after=${prevStart}`
    : baseHref
  const ranked = rows.filter(r => r.overallRank !== null)
  const firstRankShown = ranked[0]?.overallRank ?? 0
  const lastRankShown  = ranked[ranked.length - 1]?.overallRank ?? 0

  // RD-RESULTS-PUBLIC-FIX-01 · JSON-LD for the race itself. The event page already emits a
  // SportsEvent; this is the RACE within it, which is the page a search engine is most
  // likely to surface for "<event> <distance> results". Emitted only from data we hold —
  // nothing is invented for crawlers.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type':    'SportsEvent',
    name:       `${race.eventName} — ${race.passName}`,
    url:        `${BASE_URL}${baseHref}`,
    ...(race.eventDate ? { startDate: race.eventDate } : {}),
    eventStatus: 'https://schema.org/EventCompleted',
    superEvent: {
      '@type': 'SportsEvent',
      name: race.eventName,
      url:  `${BASE_URL}/results/${eventSlug}`,
    },
  }

  return (
    <ResultsShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <ResultsBreadcrumb items={[
        { label: 'Results',      href: '/results' },
        { label: race.eventName, href: `/results/${eventSlug}` },
        { label: race.passName },
      ]} />

      <ResultsHeader
        eyebrow={race.eventName}
        title={`${race.passName} Results`}
        subtitle={`${race.finisherCount.toLocaleString('en-IN')} finishers · ${race.totalCount.toLocaleString('en-IN')} results published`}
      />

      <ResultsSearch
        action={baseHref}
        initialQuery={query}
        hint="Enter a full bib number, or the start of a runner's name."
      />

      {searching ? (
        <section aria-label="Search results">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-fs-lg font-semibold text-foreground">
              {rows.length === 0
                ? 'No matches'
                : `${rows.length} ${rows.length === 1 ? 'match' : 'matches'}`}
            </h2>
            <Link href={baseHref} className="text-fs-sm font-medium text-primary hover:underline">
              Back to full leaderboard
            </Link>
          </div>

          {rows.length === 0 ? (
            <div className="rounded-xl border border-border bg-card px-6 py-12 text-center">
              <div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-muted" aria-hidden>
                <Users className="size-5 text-muted-foreground" />
              </div>
              <p className="mt-3 text-fs-md font-semibold text-foreground">
                Nothing matched &ldquo;{query}&rdquo;
              </p>
              <p className="mx-auto mt-1 max-w-sm text-fs-base leading-relaxed text-muted-foreground">
                Check the bib number, or try the first few letters of the name as printed on
                the entry list. Name search matches the start of a name, not the middle.
              </p>
            </div>
          ) : (
            <LeaderboardTable rows={rows} eventSlug={eventSlug} passSlug={passSlug} />
          )}
        </section>
      ) : (
        <section aria-label="Leaderboard">
          <h2 className="mb-3 text-fs-lg font-semibold text-foreground">Leaderboard</h2>
          <LeaderboardTable rows={rows} eventSlug={eventSlug} passSlug={passSlug} />

          {/* ═══ RD-RESULTS-PUBLIC-FIX-01 · pagination ═════════════════════
              This was forward-only: a spectator on page 6 of a 10,000-runner race could
              only restart from the top.

              PREVIOUS is derived, not stored. The leaderboard is cursor-paginated on
              `overallRank` and pages are a fixed size, so the previous page begins one
              page-length back — arithmetic on the rank we arrived at, with no second
              query and no change to the backend. Below the first page it clamps to the
              top, which is exactly where "previous" should land. */}
          {(board?.nextCursor != null || afterRank !== null) && (
            <nav aria-label="Leaderboard pages" className="mt-4 flex items-center justify-between gap-3">
              <div className="flex-1">
                {afterRank !== null && (
                  <Link
                    href={prevHref}
                    rel="prev"
                    className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-5 text-fs-base font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <ArrowLeft className="size-4" aria-hidden />
                    Previous
                  </Link>
                )}
              </div>

              {/* Where you are, in ranks rather than page numbers: a cursor-paginated list
                  has no page number to show honestly, and rank is what a reader is
                  actually looking for. */}
              {rows.length > 0 && (
                <p className="shrink-0 text-fs-sm text-muted-foreground" aria-live="polite">
                  Showing {firstRankShown}–{lastRankShown} of{' '}
                  {race.finisherCount.toLocaleString('en-IN')}
                </p>
              )}

              <div className="flex flex-1 justify-end">
                {board?.nextCursor != null && (
                  <Link
                    href={`${baseHref}?after=${board.nextCursor}`}
                    rel="next"
                    className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-5 text-fs-base font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    Next
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                )}
              </div>
            </nav>
          )}

          {/* RD-RESULTS-PUBLIC-FIX-01 · non-finishers.
              The leaderboard orders by `overallRank`, and Firestore omits documents whose
              ordered field is null — so DNF / DNS / DQ rows are absent by construction, not
              by choice. Saying so is the honest fix: a spectator scanning for a runner who
              did not finish would otherwise conclude they never started. They ARE reachable
              by bib, which is what the search box above does. */}
          {race.totalCount > race.finisherCount && (
            <p className="mt-4 text-center text-fs-sm text-muted-foreground">
              {(race.totalCount - race.finisherCount).toLocaleString('en-IN')} entrant(s) did
              not finish and are not ranked here. Search their bib number above to see their
              result.
            </p>
          )}
        </section>
      )}
    </ResultsShell>
  )
}
