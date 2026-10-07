// Recently Completed Events — the rule, and the bug it fixes.
//
// ═══ THE BUG ═════════════════════════════════════════════════════════════════
// A real, published, public event had happened, and it appeared NOWHERE on the homepage.
// The cause was not the UI: `listPublishedEvents` filters `lifecycleStatus == 'published'`,
// and an event that has actually run has usually LEFT that state — closing registration moves
// it to 'registration_closed', the organizer's Complete action moves it to 'completed'. No
// page size, no ordering change and no client-side filter can surface a document the query
// structurally excludes. That is what §1 pins, against the exact document shape found in the
// development database.
//
// ═══ WHAT MUST NOT REGRESS ═══════════════════════════════════════════════════
// Reaching into two more lifecycle states widens a PUBLIC listing, so every gate that
// protected the published listing has to still hold here: private events, admin takedowns and
// archived events stay invisible, and 'cancelled' / 'unpublished' / 'draft' are never even
// queried. §3 pins each one.
//
// Runs in the `node` environment against a Firestore double that actually APPLIES `where`,
// `orderBy`, `limit` and `startAfter` — a passthrough stub would let a cancelled event through
// and report a green test for a broken gate.

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'

// ── Firestore double ──────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  interface RawEvent { id: string; data: Record<string, unknown> }

  const store = {
    events:     [] as RawEvent[],
    counters:   new Map<string, number>(),
    /** Every `where(...)` the code applied, so the QUERY itself can be asserted. */
    whereCalls: [] as Array<[string, string, unknown]>,
    /** Every `limit(n)`, to prove the scan is bounded rather than unbounded. */
    limits:     [] as number[],
    /** How many documents the code actually read. */
    docsRead:   0,
    getAllRefs: [] as string[],
  }

  const value = (d: Record<string, unknown>, path: string): unknown =>
    path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown> | undefined)?.[k], d)

  const docSnap = (e: RawEvent) => ({ id: e.id, exists: true, data: () => e.data })

  const queryStub = (docs: RawEvent[]): Record<string, unknown> => ({
    where: (field: string, op: string, v: unknown) => {
      store.whereCalls.push([field, op, v])
      const kept = docs.filter(d => {
        const actual = value(d.data, field)
        if (op === 'in') return Array.isArray(v) && v.includes(actual)
        if (op === '==') return actual === v
        throw new Error(`stub does not implement operator ${op}`)
      })
      return queryStub(kept)
    },
    orderBy: (field: string, dir: string) => queryStub(
      [...docs].sort((a, b) => {
        const av = String(value(a.data, field) ?? '')
        const bv = String(value(b.data, field) ?? '')
        return dir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv)
      }),
    ),
    limit: (n: number) => { store.limits.push(n); return queryStub(docs.slice(0, n)) },
    startAfter: (cur: { id: string }) => {
      const i = docs.findIndex(d => d.id === cur.id)
      return queryStub(i === -1 ? docs : docs.slice(i + 1))
    },
    get: async () => {
      const snapshot = docs.map(docSnap)
      store.docsRead += snapshot.length
      return { docs: snapshot, size: snapshot.length, empty: snapshot.length === 0 }
    },
    count: () => ({ get: async () => ({ data: () => ({ count: docs.length }) }) }),
    doc: (id: string) => ({ id }),
  })

  const adminDb = {
    collection: (name: string) => {
      if (name === 'events') return queryStub(store.events)
      if (name === 'registrationCounters') return { doc: (id: string) => ({ id }) }
      return queryStub([])
    },
    getAll: async (...refs: { id: string }[]) => {
      store.getAllRefs.push(...refs.map(r => r.id))
      return refs.map(r => ({
        id:     r.id,
        exists: store.counters.has(r.id),
        data:   () => ({ totalCount: store.counters.get(r.id) ?? 0 }),
      }))
    },
  }

  return { store, adminDb }
})

vi.mock('@/lib/firebase/admin', () => ({ adminDb: h.adminDb }))
vi.mock('@/lib/organizer/identity', () => ({
  organizersQuery: () => ({ count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }) }),
}))

import {
  listRecentlyCompletedEvents,
  listPublishedEvents,
  PUBLIC_LIFECYCLE,
  RECENT_COMPLETED_WINDOW_DAYS,
} from '@/lib/firebase/firestore/publicEvents'
import {
  completionDate, isCompleted, daysAgoISO, recentlyCompleted, upcomingSoonest, todayISO,
} from '@/components/discovery/lib/collection'
import type { PublicEventCard } from '@/lib/firebase/firestore/publicEvents'

const store = h.store

// The date every test reasons from.
//
// ═══ THE FIXTURE DATE IS NOT ENOUGH ON ITS OWN ═══════════════════════════════
// This comment used to say "fixed, so no test can pass or fail because of the calendar;
// `today` is threaded through the production signature for exactly this reason." That is
// true of `recentlyCompleted`, which takes `today` as a parameter — and false of
// `upcomingSoonest`, which takes none and reads the WALL CLOCK through `todayISO()`.
//
// So the overlap test below, which calls both, was only ever aligned on the day the file
// was written. It expired at the 2026-09-07 UTC rollover: the 'running' fixture ends
// TODAY+1 = 2026-09-06, which stopped being upcoming, and the assertion that it appears in
// both lists began failing every day thereafter.
//
// The clock is therefore frozen to the same date the fixtures use. Only `Date` is faked —
// `toFake: ['Date']` leaves setTimeout, setInterval and queueMicrotask real, so nothing
// else in this file (or after it) sees a modified timer — and `afterAll` restores it.
//
// This is the identical fix already applied to homepageEventSections.test.ts, for the
// identical reason. Production is untouched: `upcomingSoonest` still has one caller and one
// correct answer, and widening its signature to suit a test would put a way to lie about
// the date into shipping code.
const TODAY = '2026-09-05'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  // Noon, so the frozen instant is not sitting on a date boundary in any timezone.
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

/**
 * The REAL document shape, copied from the development database rather than imagined:
 * lifecycleStatus at the top level, dates under eventDetails.schedule, publishedAt a
 * Firestore Timestamp. Nothing here is invented — no attendance, no ratings, no popularity.
 */
function eventDoc(over: {
  slug: string
  lifecycleStatus?: string
  startDate?: string
  endDate?: string | null
  visibility?: string | null
  moderationStatus?: string
  archivedAt?: unknown
  status?: string
  publishedAt?: string
  name?: string
}) {
  const start = over.startDate ?? day(-14)
  return {
    id: over.slug,
    data: {
      lifecycleStatus: over.lifecycleStatus ?? 'registration_closed',
      ...('visibility' in over ? { visibility: over.visibility } : {}),
      ...(over.moderationStatus ? { moderationStatus: over.moderationStatus } : {}),
      ...('archivedAt' in over ? { archivedAt: over.archivedAt } : {}),
      ...(over.status ? { status: over.status } : {}),
      eventType: 'sports',
      publishedAt: { toDate: () => new Date(over.publishedAt ?? '2026-07-01T00:00:00.000Z') },
      totalCapacity: 500,
      eventDetails: {
        info:      { name: over.name ?? 'VANATHUKKUL NOYYAL MARATHON', tagline: 'Run for the river' },
        schedule:  { startDate: start, endDate: over.endDate === null ? undefined : (over.endDate ?? start), startTime: '06:00' },
        venue:     { type: 'physical', physical: { city: 'Tiruppur', state: 'Tamil Nadu' } },
        media:     { coverBanner: { value: 'https://cdn.example/banner.jpg' }, logo: { value: 'https://cdn.example/logo.png' } },
        organizer: { name: 'UDHAYAM FOUNDATION', logoUrl: 'https://cdn.example/org.png' },
      },
      pricing: { eventType: 'paid', passes: [{ name: '10K', price: 500, status: 'active' }] },
      registrationForm: { settings: { approvalMode: 'auto' } },
    },
  }
}

beforeEach(() => {
  store.events = []
  store.counters = new Map()
  store.whereCalls = []
  store.limits = []
  store.docsRead = 0
  store.getAllRefs = []
})

const run = (opts: Parameters<typeof listRecentlyCompletedEvents>[0] = {}) =>
  listRecentlyCompletedEvents({ today: TODAY, ...opts })

// ═══ 1 · The reported bug ════════════════════════════════════════════════════

describe('the reported bug — a real completed event was invisible', () => {
  // This is the actual document found in the development database: a public marathon that
  // ended on 2026-08-22, sitting in 'registration_closed'.
  const realEvent = () => eventDoc({
    slug: 'noyyal-marathon-2026',
    lifecycleStatus: 'registration_closed',
    startDate: '2026-08-22',
    endDate: '2026-08-22',
  })

  it('REPRODUCES it: the published listing cannot return the event', async () => {
    store.events = [realEvent()]
    const { events } = await listPublishedEvents({ limit: 24 })
    // Not a UI fault and not a page-size fault — the query excludes the document outright.
    expect(events).toHaveLength(0)
  })

  it('FIXES it: the completed listing returns that same event', async () => {
    store.events = [realEvent()]
    store.counters.set('noyyal-marathon-2026', 5)

    const out = await run({ take: 4 })

    expect(out.map(e => e.slug)).toEqual(['noyyal-marathon-2026'])
    const e = out[0]
    expect(e.name).toBe('VANATHUKKUL NOYYAL MARATHON')
    expect(e.endDate).toBe('2026-08-22')
    expect(e.city).toBe('Tiruppur')
    expect(e.eventType).toBe('sports')
    expect(e.totalCount).toBe(5)
    // The card maps every field directly; an undefined renders as a blank.
    for (const [k, v] of Object.entries(e)) expect(v, `field ${k}`).not.toBeUndefined()
  })

  it('reaches an event in each of the three public states, and only those', async () => {
    store.events = [
      eventDoc({ slug: 'was-published',  lifecycleStatus: 'published',           startDate: day(-3) }),
      eventDoc({ slug: 'reg-closed',     lifecycleStatus: 'registration_closed', startDate: day(-4) }),
      eventDoc({ slug: 'marked-done',    lifecycleStatus: 'completed',           startDate: day(-5) }),
    ]
    const out = await run({ take: 10 })
    expect(out.map(e => e.slug).sort()).toEqual(['marked-done', 'reg-closed', 'was-published'])
  })
})

// ═══ 2 · The completion boundary ═════════════════════════════════════════════

describe('the completion boundary — and no overlap with Upcoming', () => {
  it('excludes an event that has not happened yet', async () => {
    store.events = [eventDoc({ slug: 'future', startDate: day(10) })]
    expect(await run()).toEqual([])
  })

  it('treats an event ending TODAY as upcoming, not completed — it may still be running', async () => {
    store.events = [eventDoc({ slug: 'today', startDate: day(-2), endDate: TODAY })]
    expect(await run()).toEqual([])
  })

  it('uses endDate for a multi-day event, so one still running is not "completed"', async () => {
    store.events = [eventDoc({ slug: 'festival', startDate: day(-3), endDate: day(2) })]
    expect(await run()).toEqual([])
  })

  it('falls back to startDate for a single-day event with no endDate', async () => {
    store.events = [eventDoc({ slug: 'oneday', startDate: day(-6), endDate: null })]
    expect((await run()).map(e => e.slug)).toEqual(['oneday'])
  })

  it('excludes an undated event rather than guessing it is over', async () => {
    const doc = eventDoc({ slug: 'undated' })
    ;(doc.data.eventDetails as { schedule: Record<string, unknown> }).schedule = { startTime: '06:00' }
    store.events = [doc]
    expect(await run()).toEqual([])
  })

  it('agrees with Upcoming: no event can appear in both sections', async () => {
    store.events = [
      eventDoc({ slug: 'past',    lifecycleStatus: 'published', startDate: day(-5) }),
      eventDoc({ slug: 'running', lifecycleStatus: 'published', startDate: day(-1), endDate: day(1) }),
      eventDoc({ slug: 'ahead',   lifecycleStatus: 'published', startDate: day(9) }),
    ]
    const completedSlugs = (await run({ take: 10 })).map(e => e.slug)
    const { events } = await listPublishedEvents({ limit: 24 })
    const upcomingSlugs = upcomingSoonest(events, 10).map(e => e.slug)

    expect(completedSlugs).toEqual(['past'])
    expect(upcomingSlugs.sort()).toEqual(['ahead', 'running'])
    expect(completedSlugs.filter(s => upcomingSlugs.includes(s))).toEqual([])
  })
})

// ═══ 3 · Every public gate still holds ═══════════════════════════════════════

describe('widening the lifecycle filter must not widen anything else', () => {
  it('queries exactly the three public states — never draft, cancelled or unpublished', async () => {
    store.events = [
      eventDoc({ slug: 'cancelled',   lifecycleStatus: 'cancelled',   startDate: day(-3) }),
      eventDoc({ slug: 'unpublished', lifecycleStatus: 'unpublished', startDate: day(-3) }),
      eventDoc({ slug: 'draft',       lifecycleStatus: 'draft',       startDate: day(-3) }),
      eventDoc({ slug: 'real',        lifecycleStatus: 'completed',   startDate: day(-3) }),
    ]
    const out = await run({ take: 10 })
    expect(out.map(e => e.slug)).toEqual(['real'])

    // Asserted on the QUERY, not just the result: an in-memory filter would pass the check
    // above while still reading (and paying for) every draft in the catalogue.
    const lifecycle = store.whereCalls.filter(([f]) => f === 'lifecycleStatus')
    expect(lifecycle).toHaveLength(1)
    expect(lifecycle[0][1]).toBe('in')
    expect(lifecycle[0][2]).toEqual([...PUBLIC_LIFECYCLE])
    expect(PUBLIC_LIFECYCLE).toEqual(['published', 'registration_closed', 'completed'])
  })

  it('hides an explicitly PRIVATE event', async () => {
    store.events = [eventDoc({ slug: 'private', visibility: 'private', startDate: day(-3) })]
    expect(await run()).toEqual([])
  })

  it('still shows a legacy event with no visibility field, and one marked public', async () => {
    store.events = [
      eventDoc({ slug: 'legacy', startDate: day(-3) }),                        // key absent
      eventDoc({ slug: 'null-vis', visibility: null, startDate: day(-4) }),
      eventDoc({ slug: 'public', visibility: 'public', startDate: day(-5) }),
    ]
    expect((await run({ take: 10 })).map(e => e.slug)).toEqual(['legacy', 'null-vis', 'public'])
  })

  it('hides an admin-taken-down event', async () => {
    store.events = [eventDoc({ slug: 'down', moderationStatus: 'taken_down', startDate: day(-3) })]
    expect(await run()).toEqual([])
  })

  it('hides an archived event caught by the archivedAt stamp', async () => {
    // Archiving KEEPS publishedAt and can leave lifecycleStatus reading as one of the three,
    // so the stamp is the signal that must catch it.
    store.events = [eventDoc({
      slug: 'arch-stamp', lifecycleStatus: 'completed', startDate: day(-3), archivedAt: { seconds: 1 },
    })]
    expect(await run()).toEqual([])
  })

  it('shows an event whose archivedAt was explicitly cleared by a restore', async () => {
    store.events = [eventDoc({
      slug: 'restored', lifecycleStatus: 'completed', startDate: day(-3), archivedAt: null,
    })]
    expect((await run()).map(e => e.slug)).toEqual(['restored'])
  })
})

// ═══ 4 · Ordering, size and cost ═════════════════════════════════════════════

describe('ordering, size and cost', () => {
  it('orders MOST RECENTLY COMPLETED first, not by publish date', async () => {
    store.events = [
      eventDoc({ slug: 'oldest', startDate: day(-30), publishedAt: '2026-08-30T00:00:00.000Z' }),
      eventDoc({ slug: 'newest', startDate: day(-1),  publishedAt: '2026-01-01T00:00:00.000Z' }),
      eventDoc({ slug: 'middle', startDate: day(-10), publishedAt: '2026-06-01T00:00:00.000Z' }),
    ]
    expect((await run({ take: 10 })).map(e => e.slug)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('returns at most `take` cards', async () => {
    store.events = Array.from({ length: 9 }, (_, i) =>
      eventDoc({ slug: `e${i}`, startDate: day(-(i + 1)) }))
    expect(await run({ take: 4 })).toHaveLength(4)
  })

  it('bounds the window: an event completed long ago is not "recent"', async () => {
    store.events = [
      eventDoc({ slug: 'inside',  startDate: day(-(RECENT_COMPLETED_WINDOW_DAYS - 1)) }),
      eventDoc({ slug: 'outside', startDate: day(-(RECENT_COMPLETED_WINDOW_DAYS + 1)) }),
    ]
    expect((await run({ take: 10 })).map(e => e.slug)).toEqual(['inside'])
  })

  it('reads a BOUNDED number of documents, never the whole collection', async () => {
    store.events = Array.from({ length: 1500 }, (_, i) =>
      eventDoc({ slug: `e${i}`, startDate: day(-2), publishedAt: `2026-0${(i % 8) + 1}-01T00:00:00.000Z` }))

    await run({ take: 4 })

    // Every page is capped, and the scan stops well short of the collection.
    expect(store.limits.every(n => n <= 200)).toBe(true)
    expect(store.docsRead).toBeLessThanOrEqual(800)
    expect(store.docsRead).toBeLessThan(1500)
  })

  it('fetches registration counters only for the cards that will render', async () => {
    store.events = Array.from({ length: 20 }, (_, i) =>
      eventDoc({ slug: `e${i}`, startDate: day(-(i + 1)) }))
    await run({ take: 4 })
    expect(store.getAllRefs).toHaveLength(4)
  })

  it('reports 0 registrations — never an invented number — when no counter exists', async () => {
    store.events = [eventDoc({ slug: 'nocounter', startDate: day(-3) })]
    expect((await run())[0].totalCount).toBe(0)
  })
})

// ═══ 5 · The shared pure boundary ════════════════════════════════════════════
//
// The section component and the data layer must not each decide what "completed" means.
// These pin the one module both sides read.

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

describe('collection.ts — completionDate / isCompleted / recentlyCompleted', () => {
  it('completionDate prefers endDate and falls back to startDate', () => {
    expect(completionDate(card({ startDate: '2026-01-01', endDate: '2026-01-03' }))).toBe('2026-01-03')
    expect(completionDate(card({ startDate: '2026-01-01' }))).toBe('2026-01-01')
    expect(completionDate(card())).toBeNull()
  })

  it('isCompleted is strictly before today, and never true for an undated event', () => {
    expect(isCompleted(card({ startDate: day(-1) }), TODAY)).toBe(true)
    expect(isCompleted(card({ startDate: TODAY }), TODAY)).toBe(false)
    expect(isCompleted(card({ startDate: day(1) }), TODAY)).toBe(false)
    expect(isCompleted(card(), TODAY)).toBe(false)
  })

  it('daysAgoISO reads the same UTC clock as todayISO', () => {
    expect(daysAgoISO(0)).toBe(todayISO())
    expect(daysAgoISO(1, new Date('2026-03-01T00:00:00.000Z'))).toBe('2026-02-28')
  })

  it('recentlyCompleted orders newest-first and honours take', () => {
    const out = recentlyCompleted([
      card({ slug: 'old', startDate: '2026-08-01' }),
      card({ slug: 'new', startDate: '2026-09-01' }),
      card({ slug: 'mid', startDate: '2026-08-20' }),
    ], 2, 365, TODAY)
    expect(out.map(e => e.slug)).toEqual(['new', 'mid'])
  })
})
