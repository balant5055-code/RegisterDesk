import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'
import type { SortKey } from '@/components/marketing/discovery/discoveryTaxonomy'

/** Today as YYYY-MM-DD, so date comparisons stay plain string comparisons. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * "Not past" — the canonical discovery definition.
 *
 * Extracted from rankByRegistrations rather than re-written, so the places that need it
 * cannot drift apart. An event is upcoming while its END date (or its start date, for a
 * single-day event) is still today or later.
 *
 * An UNDATED event counts as upcoming, which is exactly what the featured ranking has always
 * done: a published event that has not announced a date is not a past event.
 */
export function isUpcoming(event: PublicEventCard, today = todayISO()): boolean {
  return !event.startDate || (event.endDate ?? event.startDate) >= today
}

/**
 * The day an event is OVER: its end date, or its start date when it is a single-day event.
 *
 * This is the same boundary `isUpcoming` tests, written once so "upcoming" and "completed"
 * can never disagree about where the line is. It is a plain YYYY-MM-DD string, so every
 * comparison stays a string comparison.
 */
export function completionDate(event: PublicEventCard): string | null {
  return event.endDate ?? event.startDate
}

/**
 * Has this event finished?
 *
 * The exact complement of `isUpcoming` for a DATED event: it is completed once its end day
 * is strictly before today. An event ending TODAY is still upcoming — it may be running right
 * now — which is why this is `<` and not `<=`.
 *
 * An UNDATED event is never completed. `isUpcoming` treats it as upcoming, so treating it as
 * completed too would put one event in both sections.
 */
export function isCompleted(event: PublicEventCard, today = todayISO()): boolean {
  const done = completionDate(event)
  return !!done && done < today
}

/**
 * `days` before today, as YYYY-MM-DD.
 *
 * UTC, deliberately — it is the same clock `todayISO` reads, and a window whose two ends
 * came from different clocks would drift by a day for part of every day.
 */
export function daysAgoISO(days: number, from: Date = new Date()): string {
  const d = new Date(from.getTime())
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

/**
 * Recently completed events, MOST RECENTLY COMPLETED FIRST.
 *
 * Bounded at both ends: an event must have finished (before today) and must have finished
 * within `windowDays`. Without the lower bound this is "every event that ever happened",
 * which is an archive, not a homepage section.
 */
export function recentlyCompleted(
  events: PublicEventCard[],
  take: number,
  windowDays: number,
  today = todayISO(),
): PublicEventCard[] {
  // Anchored to `today`, not to the wall clock: a window whose two ends came from
  // different clocks would be off by a day whenever a caller passes an explicit date.
  const since = daysAgoISO(windowDays, new Date(today + 'T00:00:00.000Z'))
  return events
    .filter(e => {
      const done = completionDate(e)
      return !!done && done < today && done >= since
    })
    .sort((a, b) => (completionDate(b) ?? '').localeCompare(completionDate(a) ?? ''))
    .slice(0, take)
}

/**
 * Genuinely upcoming events, soonest first — for a section that is ORDERED BY DATE.
 *
 * Undated events are excluded here, unlike isUpcoming: a list sorted by "when" has nowhere
 * meaningful to put an event with no "when", and placing it first or last would both be
 * arbitrary. They remain eligible everywhere the ordering is not chronological.
 */
export function upcomingSoonest(events: PublicEventCard[], take: number): PublicEventCard[] {
  const today = todayISO()
  return events
    .filter(e => !!e.startDate && isUpcoming(e, today))
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))
    .slice(0, take)
}
/** Sort a loaded page. 'recommended' preserves the server's canonical order (publishedAt desc). */
export function sortEvents(events: PublicEventCard[], sort: SortKey): PublicEventCard[] {
  if (sort === 'recommended') return events
  const arr   = [...events]
  const today = todayISO()
  switch (sort) {
    case 'newest':     return arr.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''))
    case 'popular':    return arr.sort((a, b) => b.totalCount - a.totalCount)
    case 'price_asc':  return arr.sort((a, b) => a.minPrice - b.minPrice)
    case 'price_desc': return arr.sort((a, b) => b.minPrice - a.minPrice)
    case 'soonest':
      // Soonest upcoming first; past and undated events sink to the bottom.
      return arr.sort((a, b) => {
        const ad = a.startDate ?? '9999-12-31', bd = b.startDate ?? '9999-12-31'
        const af = ad >= today, bf = bd >= today
        if (af !== bf) return af ? -1 : 1
        return ad.localeCompare(bd)
      })
    default: return arr
  }
}

/** Name → count, most first. Facets are only ever computed from events the API returned. */
export function facetCounts(events: PublicEventCard[], key: 'city' | 'state'): { name: string; count: number }[] {
  const map = new Map<string, number>()
  for (const e of events) {
    const v = e[key]
    if (v) map.set(v, (map.get(v) ?? 0) + 1)
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Upcoming events ranked by registrations — the "featured" signal, entirely from real data. */
export function rankByRegistrations(events: PublicEventCard[], take: number): PublicEventCard[] {
  const today = todayISO()
  return [...events]
    .filter(e => isUpcoming(e, today))
    .sort((a, b) => b.totalCount - a.totalCount || (a.startDate ?? '').localeCompare(b.startDate ?? ''))
    .slice(0, take)
}
