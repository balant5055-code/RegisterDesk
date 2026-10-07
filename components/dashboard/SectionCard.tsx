'use client'

// RD-DASHBOARD-02 · Section shell + failure isolation.
//
// ═══ WHY ISOLATION MATTERS HERE ══════════════════════════════════════════════
// The old dashboard had ONE error state: a single `error` string replaced the entire
// page. So a failed coupon-performance read — a minor, optional panel — blanked the
// organizer's revenue, their alerts and their upcoming events too.
//
// A dashboard is a composition of independent questions. One unanswerable question
// must not suppress the answers to the others. `SectionCard` renders its own error
// with its own retry, and its neighbours keep working.
//
// It also distinguishes the four states the brief requires, because collapsing them
// is how a dashboard misleads:
//   loading      → skeleton
//   error        → message + retry, never zeros
//   restricted   → "not available to your role", never zeros
//   empty        → an honest "nothing here yet"

import Link from 'next/link'
import { AlertCircle, Lock, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export interface SectionCardProps {
  title:     string
  /** Accent glyph before the title. Kept separate from `title` so the string stays
   *  usable for ids and labels. */
  leading?:  React.ReactNode
  /** Optional link rendered in the header, e.g. "View all". */
  href?:     string
  hrefLabel?: string
  /** Renders the error state with a retry control. */
  error?:    string | null
  onRetry?:  () => void
  /** Renders the not-authorized state. Takes precedence over error/empty. */
  restricted?: boolean
  restrictedNote?: string
  /**
   * RD-DASHBOARD-05 — this section's numbers are WORKSPACE-level while the rest of the
   * page is scoped to one event.
   *
   * Three sections genuinely cannot be divided by event (one wallet, one payout
   * position, one workspace health), so the honest move is to say which scope the
   * figure belongs to rather than let it be read as the selected event's. Rendered as a
   * pill in the header, next to the title it qualifies — a footnote at the bottom of the
   * card is read after the number it was supposed to qualify.
   */
  scopeNote?: string
  /** One line under the title. RD-DASH-03: lets a card say what it is, not just its name. */
  subtitle?: string
  loading?:  boolean
  className?: string
  /**
   * Classes for the BODY wrapper.
   *
   * Opt-in on purpose: the body is `flex-1` for every card, and turning it into a flex
   * column by default would change the layout of every other caller. A card that needs its
   * children to fill the height asks for it.
   */
  bodyClassName?: string
  children:  React.ReactNode
}

export function SectionCard({
  title, leading, href, hrefLabel = 'View all',
  error, onRetry, restricted, restrictedNote, scopeNote, subtitle,
  loading, className, bodyClassName, children,
}: SectionCardProps) {
  const headingId = `sec-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

  return (
    <section
      aria-labelledby={headingId}
      className={cn('flex flex-col overflow-hidden rounded-surface border border-border bg-card', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2">
          {leading}
          <span className="flex min-w-0 flex-col">
            <h2 id={headingId} className="truncate text-fs-sm font-semibold leading-tight text-foreground">{title}</h2>
            {subtitle && <span className="truncate text-fs-2xs leading-tight text-muted-foreground">{subtitle}</span>}
          </span>
          {scopeNote && (
            <span
              className="shrink-0 rounded-control border border-border bg-muted/60 px-1.5 py-0.5 text-fs-2xs font-medium text-muted-foreground"
              title={`${scopeNote} — this figure is not divisible by event.`}
            >
              {scopeNote}
            </span>
          )}
        </span>
        {href && !restricted && (
          <Link
            href={href}
            className="shrink-0 rounded-control text-fs-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {hrefLabel}
          </Link>
        )}
      </div>

      <div className={cn('flex-1', bodyClassName)}>
        {restricted ? (
          <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
            <Lock className="size-4 text-muted-foreground" aria-hidden />
            <p className="text-fs-sm font-medium text-foreground">Not available to your role</p>
            <p className="max-w-xs text-fs-xs text-muted-foreground">
              {restrictedNote ?? 'Ask the workspace owner if you need access to this information.'}
            </p>
          </div>
        ) : loading ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2].map(i => <div key={i} className="h-8 animate-pulse rounded-control bg-muted" />)}
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <AlertCircle className="size-4 text-destructive" aria-hidden />
            <p className="text-fs-sm font-medium text-foreground">Couldn&apos;t load this section</p>
            <p className="max-w-xs text-fs-xs text-muted-foreground">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 inline-flex items-center gap-1.5 rounded-control border border-border px-2.5 py-1 text-fs-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <RefreshCw className="size-3.5" aria-hidden /> Retry
              </button>
            )}
          </div>
        ) : children}
      </div>
    </section>
  )
}
