// RD-RACEOPS-01 Sprint 4 · Public results chrome.
//
// SERVER COMPONENTS — no 'use client'. These render on the server, ship no JavaScript, and
// are what makes the results pages fast on a phone. Only the search box is a client island.
//
// Everything is built from the existing token layer (font-size tokens, bg-card, border-border,
// text-muted-foreground, --action-gradient). No new colour, size or radius is introduced.
//
// The accent is --action, not --primary. RegisterDesk runs a two-accent split: --action
// (indigo → violet) is the PUBLIC site's colour and --primary (magenta) belongs to the
// organizer and admin product. These pages are public — a finisher reaches them from a link,
// a stranger from search — so they carry the public accent like every other public surface.
// It is also the more legible of the two: --action is 6.29:1 on the page background where
// --primary tops out at 4.27:1.

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChevronRight, Trophy } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { HomeShell } from '@/components/discovery/home/HomeShell'
import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import { RACE_RESULT_STATUS_LABEL } from '@/features/race-operations/types/results'
import type { PublicRaceSummary, PublicResultRow } from '@/features/race-operations/types/snapshot'
import { PAGE_TITLE } from '@/lib/marketing/pageTitle'

// ─── Page shell ───────────────────────────────────────────────────────────────

/**
 * The one seam every public results route composes through — all five mount sites across
 * the four routes reach the site chrome here, and none of them mounts a navbar or a footer
 * of its own.
 *
 * ═══ WHY IT DELEGATES TO HomeShell ═══════════════════════════════════════════
 * Results is a PUBLIC discovery surface — a finisher opens it from a link and a stranger
 * finds it from search — but it used to render no site header and no site footer at all.
 * There was no way back to the rest of RegisterDesk from a leaderboard except the browser's
 * back button. HomeShell is the canonical public shell (the same one `/` and every
 * marketing page render), so adopting it is what puts this surface back on the site.
 *
 * ═══ WHAT STAYED HERE ════════════════════════════════════════════════════════
 * Only the results content well — `max-w-5xl` with its own padding rhythm. The canvas that
 * used to wrap it (`min-h-dvh bg-background`) is gone because HomeShell already owns both:
 * its root is `min-h-screen bg-background` and its `<main>` is `flex-1`, so the page still
 * fills the viewport and the footer still sits at the bottom on a short leaderboard.
 *
 * ═══ NO SECOND LANDMARK ══════════════════════════════════════════════════════
 * HomeShell owns the ONE `<main id="main-content">`. This file must never add another —
 * nested mains are invalid and would break the skip link. It never did, which is what made
 * the migration a wrapper swap rather than a restructuring.
 */
export function ResultsShell({ children }: { children: ReactNode }) {
  return (
    <HomeShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        {children}
      </div>
    </HomeShell>
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
            {i > 0 && <ChevronRight className="size-3 shrink-0 text-hero-accent-rule/70" aria-hidden />}
            {item.href
              ? <Link href={item.href} className="text-hero-ink-soft transition-colors hover:text-hero-ink">{item.label}</Link>
              : <span className="font-medium text-hero-ink" aria-current="page">{item.label}</span>}
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
      {/* 2026-09-23 luxury pass: bronze-ruled small caps, a light serif title, soft ink. */}
      {eyebrow && (
        <p className="mb-2.5 flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow">
          <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
          {eyebrow}
        </p>
      )}
      <h1 className={PAGE_TITLE}>
        {title}
      </h1>
      {subtitle && (
        <p className="mt-2 max-w-2xl text-fs-sm leading-relaxed text-hero-ink-soft">{subtitle}</p>
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
        'group flex items-center gap-3.5 rounded-lg border border-border/70 bg-card p-4',
        'transition-colors hover:border-border-strong',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action',
      )}
    >
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 text-hero-accent-rule"
        aria-hidden
      >
        <Trophy className="size-[18px]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-fs-lg text-hero-ink leading-snug transition-colors group-hover:text-action">{race.passName}</p>
        <p className="mt-1 text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-eyebrow">
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
      <p className="rounded-lg border border-border/70 bg-card px-4 py-8 text-center text-fs-base text-hero-ink-soft">
        No results to show.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border/70 bg-card">
      <table className="w-full min-w-[560px] text-fs-base">
        <thead>
          <tr className="border-b border-border/70 bg-surface-3/50 text-left text-fs-2xs font-semibold uppercase tracking-[0.16em] text-hero-eyebrow">
            <th scope="col" className="px-4 py-3">Rank</th>
            <th scope="col" className="px-4 py-3">Bib</th>
            <th scope="col" className="px-4 py-3">Participant</th>
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
                  className="font-medium text-action hover:underline"
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
