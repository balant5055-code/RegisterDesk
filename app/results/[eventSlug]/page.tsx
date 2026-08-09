// Event results — /results/{eventSlug}
//
// Lists the races (passes) with published results. Server component; snapshot-only reads.

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { CalendarDays } from 'lucide-react'
import {
  RaceCard, ResultsBreadcrumb, ResultsHeader, ResultsShell,
} from '@/features/race-operations/components/public/ResultsChrome'
import { getEventResults } from '@/features/race-operations/services/publicResults'

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 300

type Params = { params: Promise<{ eventSlug: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { eventSlug } = await params
  const event = await getEventResults(eventSlug).catch(() => null)
  if (!event) return { title: 'Results not found — RegisterDesk' }

  const title = `${event.eventName} — Results`
  const description =
    `Official results for ${event.eventName}. `
    + `${event.races.length === 1 ? '1 race' : `${event.races.length} races`}. `
    + 'Search by bib number or runner name.'
  const url = `${BASE_URL}/results/${eventSlug}`

  return {
    title, description,
    metadataBase: new URL(BASE_URL),
    alternates: { canonical: url },
    openGraph: { type: 'website', url, siteName: 'RegisterDesk', title, description },
    twitter:   { card: 'summary_large_image', title, description },
  }
}

function fmtDate(iso: string | null): string | null {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

export default async function EventResultsPage({ params }: Params) {
  const { eventSlug } = await params
  const event = await getEventResults(eventSlug).catch(() => null)
  if (!event) notFound()

  const date = fmtDate(event.eventDate)
  const totalFinishers = event.races.reduce((n, r) => n + r.finisherCount, 0)

  // JSON-LD: a SportsEvent whose results are published. Emitted only with data we actually
  // hold, so nothing is fabricated for search engines.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type':    'SportsEvent',
    name:       event.eventName,
    url:        `${BASE_URL}/results/${eventSlug}`,
    ...(event.eventDate ? { startDate: event.eventDate } : {}),
    eventStatus: 'https://schema.org/EventScheduled',
  }

  return (
    <ResultsShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <ResultsBreadcrumb items={[
        { label: 'Results', href: '/results' },
        { label: event.eventName },
      ]} />

      <ResultsHeader
        eyebrow="Official Results"
        title={event.eventName}
        subtitle={
          `${totalFinishers.toLocaleString('en-IN')} finishers across `
          + `${event.races.length === 1 ? '1 race' : `${event.races.length} races`}. `
          + 'Choose your race to search and view the leaderboard.'
        }
      />

      {date && (
        <p className="mb-5 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-fs-sm text-muted-foreground">
          <CalendarDays className="size-3.5" aria-hidden />
          {date}
        </p>
      )}

      <section aria-label="Races">
        <h2 className="mb-3 text-fs-lg font-semibold text-foreground">Races</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {event.races.map(race => (
            <li key={race.passSlug}><RaceCard race={race} /></li>
          ))}
        </ul>
      </section>
    </ResultsShell>
  )
}
