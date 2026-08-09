// Public Results landing — /results
//
// RD-RACEOPS-01 Sprint 4. SERVER COMPONENT: reads the Official Snapshot only and ships no
// JavaScript except the search island. `raceImportSessions` is not imported anywhere in
// this file's graph.

import type { Metadata } from 'next'
import Link from 'next/link'
import { CalendarDays, Trophy } from 'lucide-react'
import {
  ResultsBreadcrumb, ResultsHeader, ResultsShell,
} from '@/features/race-operations/components/public/ResultsChrome'
import { getRecentResults, groupRacesByEvent } from '@/features/race-operations/services/publicResults'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

/** Results change only when an organizer publishes, so a short ISR window is ample and
 *  keeps the landing page off the database on every hit. */
export const revalidate = 300

const TITLE = 'Race Results — RegisterDesk'
const DESCRIPTION =
  'Official race results. Search by bib number or runner name to find your finish time, '
  + 'chip time and overall position.'

export const metadata: Metadata = {
  title:        TITLE,
  description:  DESCRIPTION,
  metadataBase: new URL(BASE_URL),
  alternates:   { canonical: `${BASE_URL}/results` },
  keywords:     ['race results', 'marathon results', 'timing results', 'finish time', 'bib number', 'RegisterDesk'],
  openGraph: {
    type: 'website', url: `${BASE_URL}/results`, siteName: 'RegisterDesk',
    title: TITLE, description: DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function ResultsLandingPage() {
  const races = await getRecentResults(48).catch(() => [])
  const events = groupRacesByEvent(races)

  return (
    <ResultsShell>
      <ResultsBreadcrumb items={[{ label: 'Home', href: '/' }, { label: 'Results' }]} />
      <ResultsHeader
        eyebrow="Official Results"
        title="Race Results"
        subtitle="Find your finish time, chip time and overall position. Open an event to search by bib number or name."
      />

      {events.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-16 text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted" aria-hidden>
            <Trophy className="size-5 text-muted-foreground" />
          </div>
          <h2 className="mt-4 text-fs-md font-semibold text-foreground">No results published yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-fs-base leading-relaxed text-muted-foreground">
            When an organizer publishes race results, they will appear here.
          </p>
          <Link
            href="/events"
            className="mt-5 inline-flex items-center gap-1.5 text-fs-base font-semibold text-primary hover:opacity-80"
          >
            Browse upcoming events
          </Link>
        </div>
      ) : (
        <section aria-label="Events with published results">
          <h2 className="mb-3 text-fs-lg font-semibold text-foreground">
            Recently published
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {events.map(event => {
              const date = fmtDate(event.eventDate)
              const finishers = event.races.reduce((n, r) => n + r.finisherCount, 0)
              return (
                <li key={event.eventSlug}>
                  <Link
                    href={`/results/${event.eventSlug}`}
                    className="flex h-full flex-col gap-2 rounded-xl border border-border bg-card p-4 transition-colors hover:border-border-strong hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <p className="text-fs-md font-semibold text-foreground">{event.eventName}</p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-fs-sm text-muted-foreground">
                      {date && (
                        <span className="inline-flex items-center gap-1">
                          <CalendarDays className="size-3.5" aria-hidden />
                          {date}
                        </span>
                      )}
                      <span>
                        {event.races.length === 1 ? '1 race' : `${event.races.length} races`}
                        {' · '}
                        {finishers.toLocaleString('en-IN')} finishers
                      </span>
                    </p>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </ResultsShell>
  )
}
