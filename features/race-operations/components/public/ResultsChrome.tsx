// RD-RACEOPS-01 Sprint 4 · Public results chrome.
//
// SERVER COMPONENTS — no 'use client'. These render on the server, ship no JavaScript, and
// are what makes the results pages fast on a phone. Only the search box is a client island.
//
// Everything is built from the existing token layer (font-size tokens, bg-card, border-border,
// text-muted-foreground, --primary-gradient). No new colour, size or radius is introduced.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChevronRight, Trophy } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import { RACE_RESULT_STATUS_LABEL } from '@/features/race-operations/types/results'
import type { PublicRaceSummary, PublicResultRow } from '@/features/race-operations/types/snapshot'

// ─── Page shell ───────────────────────────────────────────────────────────────

export function ResultsShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </div>
    </div>
  )
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

export interface ResultsCrumb { label: string; href?: string }

export function ResultsBreadcrumb({ items }: { items: ResultsCrumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-fs-sm">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" aria-hidden />}
            {item.href
              ? <Link href={item.href} className="text-muted-foreground transition-colors hover:text-foreground">{item.label}</Link>
              : <span className="font-medium text-foreground" aria-current="page">{item.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}

// ─── Page header ──────────────────────────────────────────────────────────────

export function ResultsHeader({
  eyebrow, title, subtitle,
}: { eyebrow?: string; title: string; subtitle?: string }) {
  return (
    <header className="mb-6">
      {eyebrow && (
        <p className="mb-1.5 text-fs-2xs font-semibold uppercase tracking-[0.12em] text-primary">
          {eyebrow}
        </p>
      )}
      <h1 className="text-fs-xl font-bold tracking-tight text-foreground sm:text-fs-2xl">
        {title}
      </h1>
      {subtitle && (
        <p className="mt-2 text-fs-base leading-relaxed text-muted-foreground">{subtitle}</p>
      )}
    </header>
  )
}

// ─── Race card ────────────────────────────────────────────────────────────────

export function RaceCard({ race }: { race: PublicRaceSummary }) {
  return (
    <Link
      href={`/results/${race.eventSlug}/${race.passSlug}`}
      className={cn(
        'group flex items-center gap-3.5 rounded-xl border border-border bg-card p-4',
        'transition-colors hover:border-border-strong hover:bg-muted/40',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
      )}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-xl text-primary-foreground"
        style={{ backgroundImage: 'var(--primary-gradient)' }}
        aria-hidden
      >
        <Trophy className="size-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-fs-md font-semibold text-foreground">{race.passName}</p>
        <p className="mt-0.5 text-fs-sm text-muted-foreground">
          {race.finisherCount.toLocaleString('en-IN')} finishers
          {race.totalCount > race.finisherCount &&
            ` · ${race.totalCount.toLocaleString('en-IN')} results`}
        </p>
      </div>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  )
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

const STATUS_CLS: Record<string, string> = {
  finished: 'bg-success/10 text-success',
  dnf:      'bg-warning/10 text-warning',
  dns:      'bg-muted text-muted-foreground',
  dq:       'bg-destructive/10 text-destructive',
}

/**
 * Responsive results table. On phones the table scrolls horizontally inside its own
 * container rather than forcing the page to — the body never scrolls sideways.
 */
export function LeaderboardTable({
  rows, eventSlug, passSlug,
}: { rows: readonly PublicResultRow[]; eventSlug: string; passSlug: string }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-card px-4 py-8 text-center text-fs-base text-muted-foreground">
        No results to show.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[560px] text-fs-base">
        <thead>
          <tr className="border-b border-border bg-muted/40 text-left text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-4 py-3">Rank</th>
            <th scope="col" className="px-4 py-3">Bib</th>
            <th scope="col" className="px-4 py-3">Runner</th>
            <th scope="col" className="px-4 py-3">Chip Time</th>
            <th scope="col" className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map(r => (
            <tr key={r.bibNumber} className="transition-colors hover:bg-muted/20">
              <td className="px-4 py-3 font-semibold tabular-nums text-foreground">
                {r.overallRank ?? '—'}
              </td>
              <td className="px-4 py-3 tabular-nums text-muted-foreground">
                <Link
                  href={`/results/${eventSlug}/${passSlug}/${encodeURIComponent(r.bibNumber)}`}
                  className="font-medium text-primary hover:underline"
                >
                  {r.bibNumber}
                </Link>
              </td>
              <td className="max-w-[220px] truncate px-4 py-3 text-foreground">
                {r.name ?? <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-4 py-3 tabular-nums text-foreground">
                {r.chipTimeMs !== null ? formatRaceTime(r.chipTimeMs) : '—'}
              </td>
              <td className="px-4 py-3">
                <span className={cn(
                  'inline-flex rounded-md px-2 py-0.5 text-fs-2xs font-semibold',
                  STATUS_CLS[r.status] ?? 'bg-muted text-muted-foreground',
                )}>
                  {RACE_RESULT_STATUS_LABEL[r.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
