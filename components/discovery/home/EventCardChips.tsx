// ─── Landing event cards — the type and status line ──────────────────────────
//
// A SERVER component module (no hooks, no state).
//
// NOTHING HERE IS CHOSEN PER CARD. The type reads the event's own `eventType` through the ONE
// discovery taxonomy (`categoryLabel` + `CATEGORY_ICON`, the same registry the Browse row and
// the /events filters use), so an event can only ever show the label and icon its category
// already has, and an unknown type falls back to the taxonomy's own fallback icon.
//
// The status reads `eventStatus()` — the shared rule in components/discovery/lib/format that
// derives Sold out / Live now / Ended / Almost full / Closing soon / Just added from the event's
// real dates, capacity and publish time. That rule deliberately returns nothing for an ordinary
// future event; the landing cards were asked to state a status on EVERY card, so that case is
// named "Upcoming" here rather than left blank.
//
// PLACEMENT (owner feedback, 2026-09-23): this line sits ABOVE the card, on the page, not on
// the banner — organiser posters are dense artwork and chips laid over them were hard to read.

import { cn } from '@/lib/utils/cn'
import { CATEGORY_ICON, FALLBACK_CATEGORY_ICON, categoryLabel } from '@/components/marketing/discovery/discoveryTaxonomy'
import { eventStatus, type EventStatusTone } from '@/components/discovery/lib/format'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

/** The event's category: a bronze-outlined icon tile and the label in small caps. */
export function EventTypeChip({ eventType, className }: { eventType: string | null; className?: string }) {
  const Icon = CATEGORY_ICON[eventType ?? ''] ?? FALLBACK_CATEGORY_ICON
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--radius-control)] border border-hero-accent-rule/40 bg-card text-hero-accent-rule"
      >
        <Icon strokeWidth={1.75} className="size-3.5" />
      </span>
      <span className="truncate text-fs-2xs font-semibold uppercase tracking-[0.14em] text-hero-ink">
        {categoryLabel(eventType)}
      </span>
    </span>
  )
}

type Tone = EventStatusTone | 'upcoming'

/** One dot colour per status — semantic tokens only. */
const DOT: Record<Tone, string> = {
  live:     'bg-destructive',
  soldout:  'bg-foreground',
  ended:    'bg-muted-foreground',
  almost:   'bg-warning',
  closing:  'bg-warning',
  new:      'bg-action',
  upcoming: 'bg-success',
}

/** The shared status rule, with "Upcoming" naming the case it deliberately leaves blank. */
export function cardStatus(event: PublicEventCard): { label: string; tone: Tone } {
  const s = eventStatus(event)
  return s ? { label: s.label, tone: s.tone } : { label: 'Upcoming', tone: 'upcoming' }
}

export function EventStatusChip({ event, className }: { event: PublicEventCard; className?: string }) {
  const { label, tone } = cardStatus(event)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border border-border/70 bg-card px-2 py-1',
        'text-fs-2xs font-semibold uppercase tracking-[0.12em] text-hero-ink',
        className,
      )}
    >
      <span aria-hidden className="relative flex size-1.5 shrink-0">
        {tone === 'live' && (
          <span className={cn('absolute inset-0 rounded-pill opacity-60 motion-safe:animate-ping', DOT.live)} />
        )}
        <span className={cn('relative size-1.5 rounded-pill', DOT[tone])} />
      </span>
      {label}
    </span>
  )
}

/** The line that sits above a landing card: type on the left, status (when given) on the right. */
export function EventCardHeader({ event, withStatus = true }: { event: PublicEventCard; withStatus?: boolean }) {
  return (
    <div className="mb-2.5 flex min-h-7 items-center justify-between gap-2">
      <EventTypeChip eventType={event.eventType} />
      {withStatus && <EventStatusChip event={event} />}
    </div>
  )
}
