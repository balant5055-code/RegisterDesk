// RD-RESULTS-PUBLIC-FIX-01 · "Results are out" on the event page.
//
// ═══ WHY ══════════════════════════════════════════════════════════════════════
// RD-RESULTS-PUBLIC-01 found the public results pages unreachable from anywhere on the site:
// no navigation entry, and an event never linked to its own results. Every visitor had to
// arrive from a search engine or a shared link.
//
// ═══ THE GATE ═════════════════════════════════════════════════════════════════
// Rendered ONLY when `getEventResults` returns a live snapshot — the same reader the results
// pages use, which returns null unless a race is `status === 'live'`. A draft, an unpublished
// event and a cancelled import all produce nothing here, with no second rule to keep in step.
//
// A Server Component, so this costs the event page one bounded query and ships no JavaScript.

import Link from 'next/link'
import { Trophy, ArrowRight } from 'lucide-react'
import { getEventResults } from '@/features/race-operations/services/publicResults'

export async function EventResultsBanner({ eventSlug }: { eventSlug: string }) {
  // Fails soft: a results read must never take down an event page that sells tickets.
  const results = await getEventResults(eventSlug).catch(() => null)
  if (!results || results.races.length === 0) return null

  const total = results.races.reduce((n, r) => n + r.totalCount, 0)

  return (
    <div className="border-b border-border bg-muted/40">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="flex items-center gap-2.5 text-fs-sm text-foreground">
          <Trophy className="size-4 shrink-0 text-primary" aria-hidden />
          <span>
            <span className="font-semibold">Results are published.</span>{' '}
            <span className="text-muted-foreground">
              {total.toLocaleString('en-IN')} results across{' '}
              {results.races.length === 1 ? 'one race' : `${results.races.length} races`}.
            </span>
          </span>
        </p>
        <Link
          href={`/results/${encodeURIComponent(eventSlug)}`}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-4 text-fs-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          View results
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
