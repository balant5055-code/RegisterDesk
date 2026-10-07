// Custom Event template — the editorial layer and its ONE layout system.
//
// Every body section is a `LuxeBlock`: same hairline separator, same vertical rhythm,
// same header (bronze-ruled small-caps eyebrow over a serif title), same left edge. The
// page is one grid — main column + registration aside — so nothing floats on its own
// width. Tokens only: --font-display (Fraunces), --hero-* ink, --hero-accent-rule bronze.

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'
import { parseCalendarDate, formatDateShort, formatTime } from '@/components/event-templates/shared/utils/format'

/** Small-caps eyebrow led by a bronze hairline. */
export function LuxeEyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center gap-2.5 text-fs-2xs font-semibold uppercase tracking-[0.22em] text-hero-eyebrow', className)}>
      <span aria-hidden className="h-px w-6 shrink-0 bg-hero-accent-rule" />
      {children}
    </p>
  )
}

/** Small-caps field label (inside cards and lists). */
export const LUXE_LABEL = 'text-fs-2xs font-semibold uppercase tracking-[0.18em] text-hero-eyebrow'

/** Raised card on the page: hairline, no shadow. */
export const LUXE_CARD = 'rounded-surface border border-border/70 bg-card'

/**
 * One body section. `first:` rules let the first block in the column sit flush with the
 * top of the grid, so the main column and the aside start on the same line.
 */
export function LuxeBlock({ id, eyebrow, title, aside, children }: {
  id?: string; eyebrow: string; title: string; aside?: ReactNode; children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border/60 py-8 first:border-t-0 first:pt-0 last:pb-0 sm:py-10 sm:last:pb-0">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <LuxeEyebrow>{eyebrow}</LuxeEyebrow>
          <h2 className="mt-2 font-display text-fs-xl font-normal tracking-[-0.01em] text-hero-ink leading-tight sm:text-fs-2xl">
            {title}
          </h2>
        </div>
        {aside}
      </header>
      {children}
    </section>
  )
}

/** "Thursday" + "24 September 2026" for a YYYY-MM-DD string; null when unparseable. */
export function longDateParts(dateStr: string): { weekday: string; date: string } | null {
  const d = parseCalendarDate(dateStr)
  if (!d) return null
  return {
    weekday: d.toLocaleDateString('en-IN', { weekday: 'long' }),
    date:    d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
  }
}

/**
 * A sales-window moment for display: "23 Sept 2026, 6:00 PM". Sales windows are stored
 * as datetime-local ('YYYY-MM-DDTHH:mm'); a date-only value prints just the date.
 */
export function formatSalesMoment(value: string | null | undefined): string {
  const date = formatDateShort(value ?? '')
  if (!date) return ''
  const time = /T(\d{2}:\d{2})/.exec(value ?? '')?.[1]
  return time ? `${date}, ${formatTime(time)}` : date
}
