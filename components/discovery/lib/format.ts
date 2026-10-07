import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'
// ─── Helpers ──────────────────────────────────────────────────────────────────

export function parseDay(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

export function formatTime(t: string | null): string {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  return `${h % 12 || 12}:${m.toString().padStart(2, '0')} ${ampm}`
}

export function shortDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return parseDay(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

/** Compact metric formatting: 1.2K+, 350K+, 2M+ — '+' only once counts are meaningful. */
export function formatCompact(n: number): string {
  const s = n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
      : n.toLocaleString('en-IN')
  return n >= 10 ? `${s}+` : s
}

export function compactNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return n.toLocaleString('en-IN')
}

export function daysUntilDate(dateStr: string | null): number | null {
  if (!dateStr) return null
  const now = new Date(); now.setHours(0, 0, 0, 0)
  return Math.round((parseDay(dateStr).getTime() - now.getTime()) / 86_400_000)
}

/** Inclusive day span of an event, or null when it is single-day / undated. */
export function multiDaySpan(event: PublicEventCard): number | null {
  if (!event.startDate || !event.endDate || event.endDate <= event.startDate) return null
  const days = Math.round((parseDay(event.endDate).getTime() - parseDay(event.startDate).getTime()) / 86_400_000) + 1
  return days > 1 ? days : null
}

export function priceLabel(event: PublicEventCard): { text: string; free: boolean } {
  if (event.isFreeEvent || event.minPrice === 0) return { text: 'Free', free: true }
  return { text: `₹${event.minPrice.toLocaleString('en-IN')}`, free: false }
}

/** Percentage of capacity taken, or null when the event has no published capacity. */
export function fillPercent(event: PublicEventCard): number | null {
  if (!event.totalCapacity || event.totalCapacity <= 0) return null
  return Math.min(100, Math.round((event.totalCount / event.totalCapacity) * 100))
}

export function eventLocation(event: PublicEventCard): string {
  if (event.venueType === 'online') return 'Online event'
  const place = [event.city, event.state].filter(Boolean).join(', ')
  return event.venueType === 'hybrid' && place ? `${place} · Hybrid` : place
}

/**
 * The ONE badge shown top-right on a banner — the single most useful thing to know at a
 * glance. "Upcoming" is deliberately absent: it is true of almost every card and therefore
 * says nothing, and a badge on every card is visual noise rather than a signal.
 */
/** A semantic name for each status, so a surface can style it without matching on the label. */
export type EventStatusTone = 'soldout' | 'live' | 'ended' | 'almost' | 'closing' | 'new'

export function eventStatus(event: PublicEventCard): { label: string; cls: string; dot?: boolean; tone: EventStatusTone } | null {
  const today   = new Date().toISOString().slice(0, 10)
  const pct     = fillPercent(event)
  const endDate = event.endDate ?? event.startDate

  if (pct !== null && pct >= 100)                        return { label: 'Sold out',     cls: 'bg-foreground text-background', tone: 'soldout' }
  if (event.startDate && event.startDate <= today && (endDate ?? today) >= today)
                                                         return { label: 'Live now',     cls: 'bg-destructive text-white', dot: true, tone: 'live' }
  if (endDate && endDate < today)                        return { label: 'Ended',        cls: 'bg-foreground/70 text-white', tone: 'ended' }
  if (pct !== null && pct >= 85)                         return { label: 'Almost full',  cls: 'bg-warning text-white', tone: 'almost' }

  const days = daysUntilDate(event.startDate)
  if (days !== null && days >= 0 && days <= 5)           return { label: 'Closing soon', cls: 'bg-warning text-white', tone: 'closing' }

  if (event.publishedAt) {
    const pubDays = Math.floor((Date.now() - new Date(event.publishedAt).getTime()) / 86_400_000)
    if (pubDays >= 0 && pubDays <= 3)                    return { label: 'Just added',   cls: 'bg-action text-action-foreground', tone: 'new' }
  }
  return null
}
