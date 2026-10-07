// "Upcoming" as a rule, not a vibe.
//
// The homepage's Upcoming Events section must never show an event that has already finished,
// and the featured ranking on /events must keep the exact behaviour it had before the shared
// predicate was extracted out of it. These tests pin both.
//
// Pure module — no router, no DOM, no Firebase.

import { describe, it, expect } from 'vitest'
import { isUpcoming, upcomingSoonest, rankByRegistrations, todayISO } from '@/components/discovery/lib/collection'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

/** Minimal real-shaped card; only the fields these rules read are meaningful. */
function ev(over: Partial<PublicEventCard> = {}): PublicEventCard {
  return {
    id: 's', slug: 's', name: 'Event', tagline: '',
    startDate: null, endDate: null, startTime: null,
    city: null, state: null, venueType: 'physical', eventType: 'conference',
    bannerUrl: null, logoUrl: null, isFreeEvent: false, minPrice: 0,
    totalCapacity: null, totalCount: 0, organizerName: null, organizerLogo: null,
    approvalMode: 'auto', publishedAt: null,
    ...over,
  }
}

const day = (offset: number): string => {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

describe('isUpcoming — the canonical "not past" predicate', () => {
  it('counts an event starting later today or in the future', () => {
    expect(isUpcoming(ev({ startDate: todayISO() }))).toBe(true)
    expect(isUpcoming(ev({ startDate: day(30) }))).toBe(true)
  })

  it('EXCLUDES an event that has already ended', () => {
    expect(isUpcoming(ev({ startDate: day(-10), endDate: day(-2) }))).toBe(false)
    expect(isUpcoming(ev({ startDate: day(-1) }))).toBe(false)
  })

  it('counts a multi-day event that started earlier but has not ended', () => {
    // The whole reason the predicate reads endDate: a three-day festival on its second day is
    // still upcoming to anyone who has not been.
    expect(isUpcoming(ev({ startDate: day(-1), endDate: day(1) }))).toBe(true)
  })

  it('treats an event ending today as still upcoming', () => {
    expect(isUpcoming(ev({ startDate: day(-3), endDate: todayISO() }))).toBe(true)
  })

  it('treats an undated published event as upcoming, not past', () => {
    // Pre-existing behaviour of the featured ranking, preserved by the extraction.
    expect(isUpcoming(ev({ startDate: null }))).toBe(true)
  })
})

describe('upcomingSoonest — what the homepage section renders', () => {
  it('orders by start date, soonest first', () => {
    const out = upcomingSoonest([
      ev({ slug: 'c', startDate: day(20) }),
      ev({ slug: 'a', startDate: day(2) }),
      ev({ slug: 'b', startDate: day(9) }),
    ], 10)
    expect(out.map(e => e.slug)).toEqual(['a', 'b', 'c'])
  })

  it('drops past events entirely', () => {
    const out = upcomingSoonest([
      ev({ slug: 'past', startDate: day(-5) }),
      ev({ slug: 'ended', startDate: day(-9), endDate: day(-1) }),
      ev({ slug: 'future', startDate: day(4) }),
    ], 10)
    expect(out.map(e => e.slug)).toEqual(['future'])
  })

  it('drops UNDATED events, unlike isUpcoming', () => {
    // A list ordered by "when" has nowhere meaningful to put an event with no "when".
    const undated = ev({ slug: 'undated', startDate: null })
    expect(isUpcoming(undated)).toBe(true)
    expect(upcomingSoonest([undated], 10)).toEqual([])
  })

  it('caps at the requested count', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev({ slug: `e${i}`, startDate: day(i + 1) }))
    expect(upcomingSoonest(many, 8)).toHaveLength(8)
  })

  it('renders whatever is available when there are fewer than requested', () => {
    expect(upcomingSoonest([ev({ slug: 'only', startDate: day(3) })], 8)).toHaveLength(1)
  })

  it('returns an empty list rather than throwing when nothing is upcoming', () => {
    expect(upcomingSoonest([ev({ startDate: day(-2) })], 8)).toEqual([])
  })

  it('does not mutate the array it was given', () => {
    const src = [ev({ slug: 'b', startDate: day(5) }), ev({ slug: 'a', startDate: day(1) })]
    const before = src.map(e => e.slug)
    upcomingSoonest(src, 10)
    expect(src.map(e => e.slug)).toEqual(before)
  })
})

describe('rankByRegistrations keeps its original behaviour after the extraction', () => {
  it('still excludes past events and still ranks by registrations', () => {
    const out = rankByRegistrations([
      ev({ slug: 'past-popular', startDate: day(-3), totalCount: 900 }),
      ev({ slug: 'quiet',        startDate: day(5),  totalCount: 5 }),
      ev({ slug: 'busy',         startDate: day(9),  totalCount: 400 }),
    ], 5)
    expect(out.map(e => e.slug)).toEqual(['busy', 'quiet'])
  })

  it('still keeps undated events eligible', () => {
    const out = rankByRegistrations([ev({ slug: 'undated', startDate: null, totalCount: 3 })], 5)
    expect(out.map(e => e.slug)).toEqual(['undated'])
  })
})
