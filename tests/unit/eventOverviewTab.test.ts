// RD-EVENT-07 · Event Overview, asserted as rules.
//
// The defects these pin were found by auditing the real code before changing it:
//
//   O1 · The registration trend was computed IN THE BROWSER from `registrations` — one
//        page of 51 documents. A busy event whose 51 most recent sign-ups landed this
//        morning drew six empty days and one tall bar; a quiet event whose 51 spanned a
//        year drew almost nothing. Systematically wrong past 51 registrations.
//   O2 · Buckets were keyed on `toISOString().slice(0, 10)` — a UTC date — while the
//        LABEL came from `toLocaleDateString`, the viewer's local weekday. A 20:00 UTC
//        registration was counted under one day and labelled with another.
//   O3 · A missing bucket was indistinguishable from an unread one: both drew nothing,
//        implying "nobody registered that day".
//   O4 · `new Date()` during render — impure, and the 7-day window depended on the
//        client clock at render time.
//   O5 · Exact values existed only as tiny numbers above bars; nothing was reachable by
//        keyboard or screen reader.
//   O6 · Registrations / Revenue / Capacity / Check-in were re-rendered as large KPI
//        cards — the same four the RD-EVENT-05 command header owns.
//   O7 · `event.checkedInCount` and `totalRegistrations` rendered raw, so a failed
//        counter read displayed "0 / 0 checked in · 0%" as fact.
//   O8 · Overview received the 51-document page — attendee PII transferred to draw
//        aggregates.
//   O9 · Raw palette hues (`bg-emerald-500`, `bg-amber-500`), arbitrary pixel sizes,
//        `rounded-xl`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  TREND_DEFAULT_DAYS, TREND_MAX_DAYS, TREND_MIN_DAYS,
  barPercent, bucketFullLabel, bucketLabel, localDateKey, localDayStartUtc,
  parseTrendDays, trendRanges, trendView, type TrendBucket,
} from '@/lib/events/registrationTrend'
import { registrationsMetric, checkedInMetric, revenueMetric, UNAVAILABLE } from '@/lib/events/eventOverview'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'

const read  = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const CC     = strip(read('app/(dashboard)/dashboard/events/[eventId]/EventCommandCenter.tsx'))
const HEADER = strip(read('app/(dashboard)/dashboard/events/[eventId]/EventCommandHeader.tsx'))
const LIB    = strip(read('lib/events/eventOverview.ts'))
const REGAPI = strip(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const SHELL  = strip(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))

const IST = 'Asia/Kolkata'

function ev(over: Partial<EventDetailResponse> = {}): EventDetailResponse {
  return {
    draftId: 'e1', status: 'published', lifecycleStatus: 'published',
    name: 'Chennai Marathon', tagline: null, shortDesc: null, fullDesc: null, slug: 'cm',
    startDate: '2026-09-14', startTime: '05:00', endDate: null, endTime: null, timezone: IST,
    bannerUrl: null, logoUrl: null,
    eventType: 'sports', eventSubtype: null, campaignType: null, visibility: 'public',
    venueType: 'physical', venueName: 'Marina', venueCity: 'Chennai',
    venueAddress: null, onlinePlatform: null, onlineMeetingUrl: null,
    totalCapacity: 5000, totalRegistrations: 2295, checkedInCount: 288,
    confirmedRevenuePaise: 34473700, isFreeEvent: false, passes: [],
    donationTotalPaise: 0, donorCount: 0,
    publishedAt: null, updatedAt: '',
    ...over,
  } as EventDetailResponse
}

const buckets = (counts: (number | null)[]): TrendBucket[] =>
  counts.map((c, i) => ({ date: `2026-08-${String(i + 1).padStart(2, '0')}`, count: c }))

// ═══ O2 + O4 · timezone-correct day boundaries ════════════════════════════════

describe('trend buckets are day boundaries in the EVENT timezone', () => {
  it('local midnight in IST is 18:30 UTC the previous day', () => {
    const at = new Date('2026-08-28T09:00:00Z')       // 14:30 IST on the 28th
    const start = localDayStartUtc(at, IST, 0)
    expect(start.toISOString()).toBe('2026-08-27T18:30:00.000Z')
  })

  it('an instant late in UTC belongs to the NEXT local day in IST', () => {
    // 20:00 UTC on the 28th is 01:30 IST on the 29th. The old code bucketed it under
    // the 28th (UTC date) while labelling it with the local weekday — Saturday.
    expect(localDateKey(new Date('2026-08-28T20:00:00Z'), IST)).toBe('2026-08-29')
    expect(localDateKey(new Date('2026-08-28T20:00:00Z'), 'UTC')).toBe('2026-08-28')
  })

  it('handles a zone behind UTC just as correctly', () => {
    const at = new Date('2026-08-28T03:00:00Z')       // 23:00 on the 27th in New York
    expect(localDateKey(at, 'America/New_York')).toBe('2026-08-27')
    expect(localDayStartUtc(at, 'America/New_York', 0).toISOString()).toBe('2026-08-27T04:00:00.000Z')
  })

  it('survives a DST transition without shifting a whole day', () => {
    // US DST ends 2026-11-01. The day before is 24h, the day itself 25h.
    const at = new Date('2026-11-02T12:00:00Z')
    const d0 = localDayStartUtc(at, 'America/New_York', 0)
    const d1 = localDayStartUtc(at, 'America/New_York', 1)
    expect(localDateKey(d0, 'America/New_York')).toBe('2026-11-02')
    expect(localDateKey(d1, 'America/New_York')).toBe('2026-11-01')
    // The DST day really is 25 hours long — the boundaries must reflect that.
    expect(d0.getTime() - d1.getTime()).toBe(25 * 3600_000)
  })

  it('ranges are contiguous, half-open and oldest-first', () => {
    const r = trendRanges(new Date('2026-08-28T09:00:00Z'), IST, 5)
    expect(r).toHaveLength(5)
    expect(r[0].date).toBe('2026-08-24')
    expect(r[4].date).toBe('2026-08-28')
    for (let i = 0; i < r.length - 1; i++) {
      expect(r[i].end.getTime(), `${r[i].date} → ${r[i + 1].date}`).toBe(r[i + 1].start.getTime())
    }
    // The last range ends at tomorrow's local midnight, so today stays open.
    expect(r[4].end.getTime()).toBeGreaterThan(new Date('2026-08-28T09:00:00Z').getTime())
  })

  it('every bucket covers exactly one local day', () => {
    for (const r of trendRanges(new Date('2026-08-28T09:00:00Z'), IST, 7)) {
      expect(localDateKey(r.start, IST)).toBe(r.date)
      expect(r.end.getTime() - r.start.getTime()).toBe(24 * 3600_000)
    }
  })

  it('labels are rendered in the event timezone, not the viewer\'s', () => {
    expect(bucketLabel('2026-08-28', IST)).toBe('Fri')
    expect(bucketFullLabel('2026-08-28', IST)).toContain('28')
    expect(bucketLabel('nonsense', IST)).toBe('nonsense')
  })

  it('the window is bounded — a hand-typed value cannot widen it', () => {
    expect(parseTrendDays(null)).toBeNull()
    expect(parseTrendDays('abc')).toBeNull()
    expect(parseTrendDays('0')).toBe(TREND_MIN_DAYS)
    expect(parseTrendDays('9999')).toBe(TREND_MAX_DAYS)
    expect(parseTrendDays('14')).toBe(14)
    expect(TREND_MAX_DAYS).toBeLessThanOrEqual(31)
  })

  it('does not call an impure clock during render', () => {
    expect(CC).not.toContain('new Date()')
  })
})

// ═══ O3 · an unread bucket is not a zero ══════════════════════════════════════

describe('a bucket that could not be read is never drawn as zero', () => {
  it('the server returns null for a failed aggregate, never 0', () => {
    expect(REGAPI).toContain('.catch(() => null)')
    expect(REGAPI).toContain('count: counts[i]')
  })

  it('barPercent returns null for an unread bucket and 0 for a real zero', () => {
    expect(barPercent({ date: 'd', count: null }, 10)).toBeNull()
    expect(barPercent({ date: 'd', count: 0 }, 10)).toBe(0)
    expect(barPercent({ date: 'd', count: 5 }, 10)).toBe(50)
  })

  it('trendView reports partial coverage rather than a total that omits days', () => {
    const v = trendView(buckets([3, null, 5]))
    expect(v.partial).toBe(true)
    expect(v.total).toBe(8)
    expect(v.peak).toBe(5)
  })

  it('all-unread is not all-zero', () => {
    const v = trendView(buckets([null, null]))
    expect(v.total).toBeNull()
    expect(v.peak).toBeNull()
    expect(v.allZero).toBe(false)
    expect(v.partial).toBe(true)
  })

  it('a genuinely empty period IS all-zero', () => {
    const v = trendView(buckets([0, 0, 0]))
    expect(v.allZero).toBe(true)
    expect(v.partial).toBe(false)
    expect(v.total).toBe(0)
  })

  it('bar wrappers have a definite height — found by browser QA, chart was blank', () => {
    // Each bar's height is a PERCENTAGE. A percentage resolves to zero against a parent
    // of indefinite height, which is exactly what a flex child with `height: auto` is.
    // Without `h-full` on the wrapper every bar rendered at 0px and the whole chart was
    // silently empty — the tests all passed and nothing was visible.
    expect(CC).toContain('flex h-full min-w-0 flex-1 flex-col items-center justify-end')
  })

  it('the UI draws a dashed gap and says so', () => {
    expect(CC).toContain('pct === null ? (')
    expect(CC).toContain('border border-dashed border-border')
    expect(CC).toContain("Some days couldn&apos;t be counted and are shown as gaps — they are not zero.")
  })

  it('an empty period and a failed load are different messages', () => {
    expect(CC).toContain('No registrations in the last {trend.buckets.length} days.')
    expect(CC).toContain("Registration activity couldn&apos;t be loaded.")
  })
})

// ═══ O1 + O8 · the trend is server-side, over the whole dataset, PII-free ═════

describe('the trend no longer comes from a page of documents', () => {
  it('is opt-in on the existing endpoint — no new endpoint', () => {
    expect(REGAPI).toContain("parseTrendDays(params.get('trend'))")
    expect(CC).toContain('/registrations?trend=${TREND_DEFAULT_DAYS}')
  })

  it('trend mode returns NO registration rows', () => {
    expect(REGAPI).toContain('registrations: [],')
  })

  it('counts with aggregates — zero documents transferred', () => {
    const block = REGAPI.slice(REGAPI.indexOf('const trendDays'), REGAPI.indexOf('let registrations:'))
    expect(block).toContain('.count().get()')
    expect(block).not.toMatch(/\.get\(\)\s*\.then\(s => s\.docs/)
    expect(block).not.toContain('.limit(')
  })

  it('is scoped to the authorised workspace AND event', () => {
    const block = REGAPI.slice(REGAPI.indexOf('const trendDays'), REGAPI.indexOf('let registrations:'))
    expect(block).toContain("where('organizerUid', '==', uid)")
    expect(block).toContain("where('eventSlug', '==', slug)")
  })

  it('the trend never receives the document page — it still draws from aggregates', () => {
    // RD-EVENT-09 · `<OverviewTab>` is gone; the trend it owned lives in the command
    // center. The rule is unchanged: the ANALYTICS must not be computed from documents.
    expect(SHELL).toContain('<EventCommandCenter')
    // The command center does receive `regData`, because it also renders the recent-
    // registrations list — a legitimate use of the rows. What it must never do is derive
    // the trend from them.
    expect(SHELL).toContain('regData={regData}')
    expect(CC).not.toMatch(/registrations[^\n]*\.filter\([^)]*createdAt/)
    expect(CC).not.toContain('localDateKey(')
    const set = SHELL.slice(
      SHELL.indexOf('const TABS_NEEDING_REGISTRATIONS'),
      SHELL.indexOf('])', SHELL.indexOf('const TABS_NEEDING_REGISTRATIONS')),
    )
    expect(set).not.toContain("'overview'")
  })

  it('the component never iterates registration documents', () => {
    expect(CC).not.toContain('registrations.forEach')
    expect(CC).not.toContain('SerializedRegistration')
  })

  it('the aggregate count is bounded by the day window, not by event size', () => {
    // One aggregate per day, capped at TREND_MAX_DAYS — never grows with registrations.
    expect(TREND_DEFAULT_DAYS).toBeLessThanOrEqual(TREND_MAX_DAYS)
    expect(trendRanges(new Date('2026-08-28T00:00:00Z'), IST, TREND_MAX_DAYS)).toHaveLength(TREND_MAX_DAYS)
  })

  it('no read sits inside a loop beyond the bounded parallel wave', () => {
    const block = REGAPI.slice(REGAPI.indexOf('const trendDays'), REGAPI.indexOf('let registrations:'))
    expect(block).toContain('await Promise.all(ranges.map(')
    expect(block).not.toMatch(/for\s*\([\s\S]{0,120}?await/)
  })
})

// ═══ O6 + O7 · ownership and honesty ══════════════════════════════════════════

describe('metrics', () => {
  it('the duplicated KPI cards are gone', () => {
    expect(CC).not.toContain('Total Registrations')
    expect(CC).not.toContain('Capacity Used')
    expect(CC).not.toMatch(/text-\[22px\]/)
  })

  it('an unreadable counter never renders as zero', () => {
    const bad = ev({ statsUnavailable: true, totalRegistrations: 0, checkedInCount: 0 })
    expect(registrationsMetric(bad).text).toBe(UNAVAILABLE)
    expect(checkedInMetric(bad).text).toBe(UNAVAILABLE)
    expect(revenueMetric(ev({ revenueUnavailable: true })).text).toBe(UNAVAILABLE)
  })

  it('a measured zero still reads as zero', () => {
    const empty = ev({ totalRegistrations: 0, checkedInCount: 0, confirmedRevenuePaise: 0 })
    expect(registrationsMetric(empty).text).toBe('0')
    expect(revenueMetric(empty).text).toBe('₹0')
  })

  it('check-in uses the shard-folded value, and the resolver that guards it', () => {
    // event.checkedInCount flows through getEventStats → foldAttendanceShards, so it IS
    // the RD-DASH-11B value. It must go through checkedInMetric, which respects
    // statsUnavailable, rather than being rendered raw.
    // RD-EVENT-09 · The headline check-in figure moved to the shell header strip when
    // Overview's KPI row was retired, so the rule is anchored THERE. The command center
    // must not render the raw counter itself either — checked in that follows is the
    // command center's own copy of the same prohibition.
    expect(HEADER).toContain('checkedInMetric(event)')
    expect(HEADER).not.toMatch(/\{event\.checkedInCount\}/)
    expect(CC).not.toMatch(/\{event\.checkedInCount\}/)
    expect(CC).not.toMatch(/event\.checkedInCount \/ event\.totalRegistrations/)
    // The command center's check-in figures come from stats (shard-folded server-side),
    // through the same resolver the Setup and Home surfaces used.
    expect(CC).toContain('statusMetrics(event, regData)')
    expect(CC).toContain('remainingToCheckIn(regData)')
  })

  it('unavailable is announced in text', () => {
    expect(CC).toContain('<span className="sr-only">Unavailable</span>')
    expect(CC).toMatch(/couldn&apos;t be loaded/i)
  })
})

// ═══ O5 · chart accessibility ═════════════════════════════════════════════════

describe('exact values do not depend on hovering', () => {
  it('bars are decorative; a real table carries the figures', () => {
    expect(CC).toContain('aria-hidden>')
    expect(CC).toContain('<table')
    expect(CC).toContain('<caption className="sr-only">')
    expect(CC).toContain('scope="col"')
    expect(CC).toContain('scope="row"')
  })

  it('the table is reachable by keyboard', () => {
    expect(CC).toContain('<details')
    expect(CC).toContain('<summary')
    expect(CC).toContain('Show exact daily figures')
  })

  it('an unavailable day is stated in the table, not left blank', () => {
    expect(CC).toContain('b.count === null')
  })

  it('the chart states its timezone so a reader knows what a day means', () => {
    expect(CC).toContain('{trend.timeZone}')
  })
})

// ═══ Donation ═════════════════════════════════════════════════════════════════

describe('donation revenue', () => {
  it('appears only for an event_plus_donation event', () => {
    expect(CC).toContain("const isDonation = event.campaignType === 'event_plus_donation'")
    expect(CC).toContain('{isDonation && (')
  })

  it('never adds an unavailable figure to a known one', () => {
    // Combined must be unavailable when ticket revenue is, not silently the donations.
    const from = CC.indexOf('Combined')
    const to   = CC.indexOf('Schedule & venue')
    expect(from).toBeGreaterThan(-1)
    const block = CC.slice(from, to === -1 ? CC.length : to)
    // RD-ANALYTICS-12-17 · the guard is now `ticketRevenuePaise`, which is null for BOTH
    // causes — a failed read and a withheld figure. The rule is unchanged and stronger:
    // Combined never adds a figure the caller was not given.
    expect(block).toContain('ticketRevenuePaise === null')
  })

  it('reports the donor count alongside the amount', () => {
    expect(CC).toContain('event.donorCount.toLocaleString')
  })
})

// ═══ Schedule / venue ═════════════════════════════════════════════════════════

describe('schedule and venue', () => {
  it('states the timezone explicitly', () => {
    expect(CC).toContain('label="Timezone"')
  })

  it('handles online, hybrid and physical venues', () => {
    // The three-way rule lives in `locationLabel`, the ONE resolver both the command
    // center and the events list read — so neither can invent a fourth answer.
    // The label rule lives in `locationLabel`, the ONE resolver the command center and
    // the events list share — so neither can invent a different answer for the same
    // event. Online is named as such; anything with a venue reads as its venue.
    expect(LIB).toContain("e.venueType === 'online'")
    expect(LIB).toContain("return 'Online'")
    expect(CC).toContain('locationLabel(event)')
    // A map link is meaningless for an online event. Hybrid is deliberately on the
    // physical side of this line: it has a real address to navigate to.
    expect(CC).toContain("event.venueType !== 'online'")
  })

  it('a missing venue is an intentional empty state', () => {
    expect(CC).toContain("venue ?? 'Not set'")
    expect(CC).toContain('Not scheduled')
  })

  it('the map link is a real link, not a raw URL in the hierarchy', () => {
    expect(CC).toContain('View on map')
    expect(CC).toContain('encodeURIComponent(')
    expect(CC).toContain('rel="noopener noreferrer"')
  })

  it('long venue text wraps rather than clipping', () => {
    expect(CC).toContain('[overflow-wrap:anywhere]')
    expect(CC).toContain('break-words')
  })
})

// ═══ States, safety, design system ════════════════════════════════════════════

describe('states and safety', () => {
  it('has loading, error-with-retry and empty — all distinct', () => {
    expect(CC).toContain("trendState === 'loading'")
    expect(CC).toContain("trendState === 'error'")
    expect(CC).toContain('onRetry')
    expect(CC).toContain('setReloadKey(k => k + 1)')
  })

  it('a failed chart does not destroy the schedule section', () => {
    // The trend owns its own error state; the sections after it always render.
    const trendStart = CC.indexOf('Registration activity')
    expect(trendStart).toBeGreaterThan(-1)
    expect(CC.indexOf('Schedule & venue')).toBeGreaterThan(trendStart)
    // And the failure is confined to the chart's own branch, not a page-level return.
    expect(CC).toContain("trendState === 'error' || !trend || !tv ? (")
  })

  it('announces loading', () => {
    expect(CC).toContain('aria-busy="true"')
    expect(CC).toContain('aria-live="polite"')
    expect(CC).toContain('<span className="sr-only">Loading event command center…</span>')
  })

  it('never leaks a raw error', () => {
    expect(CC).not.toMatch(/\{error\}|e\.message|\.digest/)
  })

  it('performs no writes and touches no payment path', () => {
    for (const v of ['.set(', '.update(', '.delete(', 'runTransaction', 'writeBatch', 'FieldValue', 'razorpay']) {
      expect(CC.toLowerCase(), v).not.toContain(v.toLowerCase())
    }
  })

  it('sections are h2 — the page H1 belongs to the command header', () => {
    expect(CC).not.toContain('<h1')
    expect(CC).toContain('<h2')
  })

  it('uses design tokens only', () => {
    expect(CC).not.toMatch(/text-\[\d+(\.\d+)?px\]/)
    expect(CC).not.toMatch(/\brounded-(xl|lg|2xl)\b/)
    expect(CC).not.toMatch(/\b(bg|text|border)-(emerald|amber|slate|rose|sky|violet|teal|red|orange)-\d{2,3}\b/)
    expect(CC).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(CC).not.toMatch(/shadow-(sm|md|lg|xl)|backdrop-blur|\bblur-/)
    expect(CC).not.toMatch(/bg-primary(?![-/])/)
  })

  it('sections can shrink below their content', () => {
    expect((CC.match(/min-w-0/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  it('interactive controls reach 44px', () => {
    expect((CC.match(/h-11/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })
})

// ═══ Contract stability ═══════════════════════════════════════════════════════

describe('the registrations contract only grows', () => {
  it('trend is additive and optional', () => {
    expect(REGAPI).toMatch(/trend\?: \{/)
  })

  it('every pre-existing response field survives', () => {
    for (const f of ['registrations', 'eventName', 'eventSlug', 'passes', 'fieldLabels',
                     'stats', 'hasMore', 'nextCursor', 'totalCount']) {
      expect(REGAPI, f).toMatch(new RegExp(`^\\s+${f}[:?]`, 'm'))
    }
  })

  it('the normal (non-trend) path is untouched', () => {
    expect(REGAPI).toContain('const pageSize = [25, 50, 100].includes(rawLimit) ? rawLimit : 50')
    expect(REGAPI).toContain('base.limit(pageSize + 1)')
  })
})
