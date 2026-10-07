// Event results — /results/{eventSlug}
//
// Lists the races (passes) with published results. Server component; snapshot-only reads.
//
// ═══ A PUBLIC EVENT WITH NO RESULTS IS A PAGE, NOT A 404 ═════════════════════
// This route used to 404 on `getEventResults(slug) === null`, and that function returns null
// for exactly one reason: no LIVE snapshot exists for the slug. It never looks at whether the
// EVENT exists — so a real, published, finished event with results still being verified was
// indistinguishable from a slug someone invented, and both got "not found".
//
// That is wrong for the reader and it made the destination unlinkable: the homepage's
// Recently Completed card could not offer "View Results" for any event whose results were not
// yet published, which is most of them.
//
// The event is therefore resolved separately, through the SAME three checks /events/[slug]
// applies — exists, publicly-visible lifecycle, not taken down. A slug that fails those still
// 404s, exactly as before. A slug that passes but has no snapshot gets an honest page saying
// results are not published yet.
//
// It is `noindex` in that state: there is nothing on it to index, and a soft-404 in the index
// is worse than no entry. app/sitemap.ts already lists only events that HAVE live snapshots,
// so nothing advertises this state either.
//
// NOTHING IS FABRICATED. No placeholder times, no invented finisher counts, no example rows.

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { CalendarDays, Trophy } from 'lucide-react'
import {
  RaceCard, ResultsBreadcrumb, ResultsHeader, ResultsShell,
} from '@/features/race-operations/components/public/ResultsChrome'
import { getEventResults } from '@/features/race-operations/services/publicResults'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { isContentTakenDown } from '@/lib/admin/moderation'

/**
 * The event's public name, or null when the public may not see this event at all.
 *
 * The three checks are the ones app/events/[slug]/page.tsx makes, in the same order, so this
 * route can never be reachable for an event whose own page is not. The name is read the way
 * publicGalleryService reads it — `eventDetails.info.name` — rather than through a second
 * convention.
 */
async function publicEventName(slug: string): Promise<string | null> {
  const event = await getEventBySlug(slug).catch(() => null)
  if (!event) return null
  if (!canExposePublicEvent(event.lifecycleStatus)) return null
  if (isContentTakenDown(event.moderationStatus)) return null
  const details = (event as unknown as { eventDetails?: { info?: { name?: unknown } } }).eventDetails
  return typeof details?.info?.name === 'string' ? details.info.name : 'This event'
}

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 300

type Params = { params: Promise<{ eventSlug: string }> }

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { eventSlug } = await params
  const event = await getEventResults(eventSlug).catch(() => null)
  if (!event) {
    const name = await publicEventName(eventSlug)
    // A real event whose results are still to come: a real title, and noindex because the
    // page has nothing to index yet.
    if (name) {
      return {
        title: `${name} — Results — RegisterDesk`,
        description: `Results for ${name} have not been published yet.`,
        robots: { index: false, follow: true },
      }
    }
    return { title: 'Results not found — RegisterDesk' }
  }

  const title = `${event.eventName} — Results`
  const description =
    `Official results for ${event.eventName}. `
    + `${event.races.length === 1 ? '1 race' : `${event.races.length} races`}. `
    + 'Search by bib number or participant name.'
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

  if (!event) {
    // No live snapshot. Either the slug is not a public event at all — 404, unchanged — or it
    // is, and its results simply are not out yet.
    const name = await publicEventName(eventSlug)
    if (!name) notFound()
    return (
      <ResultsShell>
        <ResultsBreadcrumb items={[
          { label: 'Results', href: '/results' },
          { label: name },
        ]} />

        <ResultsHeader
          eyebrow="Results"
          title={name}
          subtitle="Results for this event have not been published yet."
        />

        {/* Deliberately plain, and deliberately empty of data. The one thing this page must
            never do is suggest a number, a time or a placeholder row: a reader who sees a
            table here will read it as the result. */}
        <div className="rounded-lg border border-border/70 bg-card px-6 py-8 text-center">
          <span className="mx-auto inline-flex size-11 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/50 text-hero-accent-rule">
            <Trophy className="size-5" strokeWidth={1.5} aria-hidden />
          </span>
          <span aria-hidden className="mx-auto mt-4 block h-px w-8 bg-hero-accent-rule" />
          <h2 className="mt-4 font-display text-fs-xl font-light text-hero-ink">Results aren’t published yet</h2>
          <p className="mx-auto mt-2 max-w-md text-fs-sm leading-relaxed text-hero-ink-soft">
            Verified race results appear here once the organizer publishes them. In the
            meantime you can still view the event.
          </p>
          <Link
            href={`/events/${eventSlug}`}
            className="mt-4 inline-flex h-9 items-center rounded-[var(--radius-control)] px-3 text-fs-xs font-semibold uppercase tracking-[0.16em] text-action underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2"
          >
            View event details
          </Link>
        </div>
      </ResultsShell>
    )
  }

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
        <p className="mb-8 inline-flex items-center gap-2 text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">
          <CalendarDays className="size-3.5 text-hero-accent-rule" aria-hidden />
          {date}
        </p>
      )}

      <section aria-label="Races">
        <h2 className="mb-4 font-display text-fs-xl font-light text-hero-ink">Races</h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {event.races.map(race => (
            <li key={race.passSlug}><RaceCard race={race} /></li>
          ))}
        </ul>
      </section>
    </ResultsShell>
  )
}
