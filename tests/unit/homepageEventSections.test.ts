// The homepage's two event sections, as RENDERED OUTPUT.
//
// ═══ 1 · THE DEAD CTAs ═══════════════════════════════════════════════════════
// /events is a 307 back to `/` (app/events/page.tsx). Upcoming Events carried two links to it
// — one beside the heading, one in the empty state — so both had become ` / → /events → / `:
// a CTA promising more events that returns the reader to the page they are on. A CSS or
// "disabled" check would be worthless here; "gone" has to mean "not in the tree", so these
// assertions run against real markup, with the sections rendered in BOTH their populated and
// empty states so nothing passes by rendering nothing at all.
//
// The header and footer keep their "Discover Events" entries on purpose. Those are navigation
// IDENTITY — a "you are here" item present on every marketing route — not a section CTA, and
// /events must stay a live URL for links, bookmarks and index entries that already use it.
//
// ═══ 2 · THE COUNT-RESPONSIVE COMPOSITION ════════════════════════════════════
// One real event in a rail built for four renders as a small card marooned in a wide blank
// row, which reads as a grid that failed to load. The fix had to come from the LAYOUT, since
// every alternative (placeholder cards, a stretched card, invented events) is a lie. These
// tests pin that the section actually changes shape with the number of REAL events, and — just
// as importantly — that it never renders more cards than it was given.
//
// Node environment: components are rendered with renderToStaticMarkup, the same way
// checkinUndoPermission.test.ts pins its controls.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { UpcomingEvents } from '@/components/discovery/home/UpcomingEvents'
import { RecentlyCompleted } from '@/components/discovery/home/RecentlyCompleted'
import { upcomingSoonest, recentlyCompleted, todayISO } from '@/components/discovery/lib/collection'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

// ═══ THE CLOCK IS FROZEN, AND IT HAS TO BE ═══════════════════════════════════
//
// Every fixture below is written relative to TODAY, but half these tests reach production
// code that reads the WALL CLOCK, so the two were only ever aligned on the day the file was
// written. They drifted apart at the next UTC midnight and the "ends today" case began
// failing every day thereafter.
//
// The leak is not where it looks. `recentlyCompleted` already takes `today` as a parameter
// and the tests pass it, so that half was deterministic. `upcomingSoonest` calls
// `todayISO()` internally and takes no such parameter — and `UpcomingEvents` calls it AGAIN
// on whatever array it is handed. So EVERY test that renders that section with a dated
// fixture depends on the real date, not just the boundary case: `day(5)`, `day(6)` and the
// four-event pool all expire, just on later dates.
//
// So the clock is frozen for the whole file rather than for one describe. Only `Date` is
// faked — `toFake: ['Date']` leaves setTimeout, setInterval and queueMicrotask real, so
// nothing else in the file, and nothing that runs after it, sees a modified timer.
// `afterAll` restores the real clock, so the mock cannot leak into another file even
// though Vitest isolates modules per file anyway.
//
// ═══ WHAT THIS DELIBERATELY DOES NOT DO ══════════════════════════════════════
// It does not add a `today` parameter to `upcomingSoonest`. Production has exactly one
// caller and one correct answer — the real date — and widening the signature to suit a test
// would put a way to lie about the date into the shipping code. Freezing the clock is the
// smaller change and it leaves the business rule untouched: `isUpcoming` still says an
// event whose end date IS today is upcoming, which is what the boundary test proves.
//
// Noon rather than midnight so the frozen instant is not sitting on a date boundary in any
// timezone the suite might run in.
const TODAY = '2026-09-05'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`))
})
afterAll(() => {
  vi.useRealTimers()
})

const day = (offset: number): string => {
  const d = new Date(`${TODAY}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

function card(over: Partial<PublicEventCard> = {}): PublicEventCard {
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

/** `n` distinct completed events — distinct slugs, so duplicates would be visible. */
const completedSet = (n: number): PublicEventCard[] =>
  Array.from({ length: n }, (_, i) => card({
    id: `done-${i}`, slug: `done-${i}`, name: `Finished Event ${i}`,
    startDate: day(-(i + 1)), endDate: day(-(i + 1)), eventType: 'conference',
  }))

const renderCompleted = (events: PublicEventCard[]) =>
  renderToStaticMarkup(createElement(RecentlyCompleted, { events }))
const renderUpcoming = (events: PublicEventCard[]) =>
  renderToStaticMarkup(createElement(UpcomingEvents, { events }))

// ═══ 1 · No CTA may send the reader to /events and straight back ═════════════

describe('the homepage event sections carry no /events round trip', () => {
  it('Upcoming Events renders no /events link when it HAS events', () => {
    const html = renderUpcoming([card({ slug: 'a', startDate: day(5), name: 'Ahead' })])
    expect(html).toContain('Ahead')            // it really did render something
    expect(html).not.toContain('href="/events"')
  })

  it('Upcoming Events renders no /events link in its EMPTY state', () => {
    const html = renderUpcoming([])
    expect(html).toContain('No upcoming events just yet')
    expect(html).not.toContain('href="/events"')
  })

  it('the old CTA wording is gone entirely, not merely repointed', () => {
    const html = renderUpcoming([]) + renderUpcoming([card({ slug: 'a', startDate: day(5) })])
    expect(html).not.toContain('View all events')
    expect(html).not.toContain('Browse all events')
  })

  it('Recently Completed never invents a listing link of its own', () => {
    const html = renderCompleted(completedSet(4))
    expect(html).toContain('Finished Event 0')
    expect(html).not.toContain('href="/events"')
    expect(html).not.toContain('/completed')
  })

  it('neither section file mentions the /events listing route at all', () => {
    // A source contract as well as a render one: a link added behind a condition these
    // fixtures do not hit would still be a dead CTA in production.
    for (const f of [
      'components/discovery/home/UpcomingEvents.tsx',
      'components/discovery/home/RecentlyCompleted.tsx',
    ]) {
      const code = read(f).split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      expect(code.join('\n'), f).not.toContain("'/events'")
      expect(code.join('\n'), f).not.toContain('"/events"')
    }
  })
})

// ═══ 2 · The composition follows the real count ══════════════════════════════

describe('Recently Completed adapts its composition to the number of real events', () => {
  it('ZERO events → the section is omitted entirely, not an empty container', () => {
    expect(renderCompleted([])).toBe('')
  })

  // ═══ THE GRID: PHONE 1 · TABLET 3 · LAPTOP 4 ═══════════════════════════════
  // `md` is 768 and `xl` is 1280. `lg` (1024) deliberately stays at three columns: a 1024
  // viewport is an iPad, and four across there gives each card 226px.
  //
  // At counts 1 and 2 there are fewer cards than tracks, so the column count decides nothing
  // and the WIDTH has to be stated instead — which is the whole reason those cases stopped
  // looking broken.

  it('ONE event → one COMPACT card, not a widened one', () => {
    const html = renderCompleted(completedSet(1))
    expect(html).toContain('grid-cols-1')
    // The per-count width caps are gone. They stopped a lone card looking orphaned by making
    // it 416px — half again an Upcoming card — so the archive read as the heavier section.
    // One track width for every count means it is always the same object.
    expect(html).not.toContain('max-w-[26rem]')
    // Scoped to the GRID: the head's lede is measure-capped on purpose, and a cap there
    // is not a card width cap.
    expect(html).not.toMatch(/<ul[^>]*max-w-\[/)
    expect((html.match(/<li/g) ?? [])).toHaveLength(1)
  })

  it('never turns a card on its side to fill a row', () => {
    // A revision did exactly this for the single-event case. The section fills a row with
    // COLUMNS; the card is the same vertical object at every count and every width.
    for (const n of [1, 2, 3, 4]) {
      expect(renderCompleted(completedSet(n)), `count ${n}`).not.toContain('lg:flex-row')
    }
  })

  it('uses the SAME grid whatever the count', () => {
    // Phone 1 → tablet 3 → laptop 4, at every count, so a card is never resized by how many
    // of them there happen to be.
    for (const n of [1, 2, 3, 4]) {
      const html = renderCompleted(completedSet(n))
      expect(html, `count ${n}`).toContain('grid-cols-1 md:grid-cols-3 xl:grid-cols-4')
      expect((html.match(/<li/g) ?? []), `count ${n}`).toHaveLength(n)
    }
  })

  it('TWO events → the same grid, no width cap', () => {
    const html = renderCompleted(completedSet(2))
    expect(html).toContain('md:grid-cols-3')
    expect(html).not.toMatch(/<ul[^>]*max-w-\[/)
    expect((html.match(/<li/g) ?? [])).toHaveLength(2)
  })

  it('THREE events → three columns from the tablet breakpoint', () => {
    const html = renderCompleted(completedSet(3))
    expect(html).toContain('md:grid-cols-3')
    expect((html.match(/<li/g) ?? [])).toHaveLength(3)
  })

  it('FOUR events → 1 on a phone, 3 on a tablet, 4 on a laptop', () => {
    const html = renderCompleted(completedSet(4))
    expect(html).toContain('grid-cols-1')
    expect(html).toContain('md:grid-cols-3')
    expect(html).toContain('xl:grid-cols-4')
    // Not at lg: 1024 is an iPad, and four across there would give each card 226px.
    expect(html).not.toContain('lg:grid-cols-4')
    expect((html.match(/<li/g) ?? [])).toHaveLength(4)
  })

  it('renders each event once — no duplicate cards', () => {
    // Counted as CARDS, not as hrefs. The archive card deliberately links to the event
    // twice — the title and the "Event details" action — so counting /events/<slug> would
    // now report a duplicate for a card that is rendered exactly once.
    const html = renderCompleted(completedSet(4))
    expect((html.match(/<article/g) ?? [])).toHaveLength(4)
    for (let i = 0; i < 4; i++) {
      expect((html.match(new RegExp(`Finished Event ${i}<`, 'g')) ?? []), `event ${i}`).toHaveLength(1)
    }
  })
})

// ═══ 3 · Hierarchy and honesty of the card ═══════════════════════════════════

describe('the two sections read as primary and secondary', () => {
  it('Upcoming keeps the larger heading — the hierarchy is scale, not weight', () => {
    const html = renderUpcoming([])
    // The masthead is the display face at LIGHT weight (SectionHead). --fs-display-sm is
    // the token whose documented job is a section heading: 28px on a phone, 40px at 1440.
    expect(html).toContain('text-fs-display-sm')
    expect(html).toContain('font-display font-light')
    // Nothing in the heading is set in a heavy weight — the hierarchy is carried by size.
    expect(html).not.toMatch(/<h2[^>]*font-(?:semibold|bold)/)
  })

  it('Recently Completed is headed one step down, and separated by a rule', () => {
    const html = renderCompleted(completedSet(1))
    // --fs-xl (24px flat), NOT --fs-2xl: 28px is exactly where --fs-display-sm bottoms
    // out, so a 2xl secondary heading matched the primary one on every phone.
    expect(html).toMatch(/<h2[^>]*text-fs-xl/)
    expect(html).toContain('font-display font-light')
    expect(html).not.toContain('text-fs-display-sm')
    expect(html).not.toContain('text-fs-2xl')
    expect(html).toContain('border-t')
  })

  it('both mastheads are centred, eyebrowed and ruled in the same warm metal', () => {
    // One component draws both (components/discovery/home/SectionHead.tsx): the landing
    // cannot drift into two different section-title treatments again.
    for (const [label, html] of [
      ['upcoming',  renderUpcoming([])],
      ['completed', renderCompleted(completedSet(1))],
    ] as const) {
      expect(html, label).toContain('flex flex-col items-center text-center')
      expect(html, label).toMatch(/tracking-\[0\.3em\] text-muted-foreground/)  // the eyebrow lockup
      expect(html, label).toContain('h-px w-10 bg-hero-accent-rule')            // the one ornament
      expect(html, label).not.toContain('rd-brand-gradient')
    }
    // The eyebrows NAME the section; neither states a quantity the page must keep true.
    expect(renderUpcoming([])).toContain('What&#x27;s on')
    expect(renderCompleted(completedSet(1))).toContain('The archive')
  })

  it('a completed card states Completed and shows no price', () => {
    const html = renderCompleted([card({
      slug: 'paid-done', name: 'Paid And Finished', startDate: day(-2),
      minPrice: 50000, isFreeEvent: false, city: 'Tiruppur', state: 'Tamil Nadu',
      eventType: 'conference',
    })])
    expect(html).toContain('Completed')
    expect(html).toContain('Tiruppur')
    expect(html).toContain('Conferences')
    expect(html).not.toContain('₹50,000')
    // Not styled as an error or a disabled control.
    expect(html).toContain('text-accent-people-fg')
  })

  it('an upcoming card still shows its price, unchanged', () => {
    const html = renderUpcoming([card({
      slug: 'paid-ahead', name: 'Paid Ahead', startDate: day(6), minPrice: 50000,
    })])
    expect(html).toContain('₹50,000')
    expect(html).not.toContain('Completed')
  })

  it('invents no attendance, rating, popularity or registration figure', () => {
    const html = renderCompleted([card({
      slug: 'counted', name: 'Counted', startDate: day(-2), totalCount: 137,
    })])
    for (const word of ['137', 'attendee', 'attended', 'rating', 'popular', 'views', 'going']) {
      expect(html.toLowerCase(), `leaked "${word}"`).not.toContain(word.toLowerCase())
    }
  })

  it('is generic across event types — no marathon-specific rendering', () => {
    const types = ['conference', 'workshop', 'meetup', 'fundraiser', 'cultural', 'sports']
    for (const eventType of types) {
      const html = renderCompleted([card({ slug: `t-${eventType}`, name: 'X', startDate: day(-2), eventType })])
      expect(html, eventType).toContain('Completed')
      expect(html, eventType).toContain('grid-cols-1')
    }
  })
})

// ═══ 4 · The two sections cannot show the same event ═════════════════════════

describe('upcoming / completed separation at the render boundary', () => {
  const pool = [
    card({ slug: 'past',    name: 'Past',    startDate: day(-5) }),
    card({ slug: 'running', name: 'Running', startDate: day(-1), endDate: day(1) }),
    card({ slug: 'today',   name: 'EndsToday', startDate: day(-3), endDate: TODAY }),
    card({ slug: 'ahead',   name: 'Ahead',   startDate: day(9) }),
  ]

  it('no slug appears in both rendered sections', () => {
    const up = renderUpcoming(upcomingSoonest(pool, 8))
    const done = renderCompleted(recentlyCompleted(pool, 4, 90, TODAY))

    for (const e of pool) {
      const inUp = up.includes(`/events/${e.slug}"`)
      const inDone = done.includes(`/events/${e.slug}"`)
      expect(inUp && inDone, `${e.slug} appears in both`).toBe(false)
    }
    expect(done).toContain('/events/past"')
    expect(up).toContain('/events/ahead"')
  })

  it('the frozen clock is the one PRODUCTION reads', () => {
    // The guard on everything else in this file. If the freeze ever stops reaching
    // todayISO() — the function upcomingSoonest calls internally — then every dated
    // fixture here is silently betting on the real date again, which is exactly how the
    // boundary test below started failing once a day.
    expect(todayISO()).toBe(TODAY)
  })

  it('an event ending TODAY renders as upcoming, never as completed', () => {
    const up = renderUpcoming(upcomingSoonest(pool, 8))
    const done = renderCompleted(recentlyCompleted(pool, 4, 90, TODAY))
    expect(up).toContain('/events/today"')
    expect(done).not.toContain('/events/today"')
  })
})
