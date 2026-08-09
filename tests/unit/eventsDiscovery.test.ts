// /events discovery — the DATA LAYER half.
//
// The production report: the page shell rendered (hero, stats, filters, "Upcoming Events")
// but the cards were intermittently missing, including on a hard refresh, while published
// events existed. This file pins that the query itself returns the real dataset, normalizes
// every field the card consumes, filters without destroying the dataset, and REJECTS on
// failure rather than resolving to an empty list.
//
// The server-page half — that a rejection is propagated instead of being rendered as an
// empty (and therefore ISR-cached) page — lives in eventsPageBoundary.test.ts, which must
// mock this module and so cannot share a file with these tests.
//
// Runs in the `node` environment with Firebase Admin stubbed: no emulator, no credentials,
// no network.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Firestore stub ────────────────────────────────────────────────────────────
// A chainable query double covering exactly the calls listPublishedEvents makes:
// where → orderBy → limit → startAfter → get, plus count().get() and getAll().
// Built inside vi.hoisted so the hoisted vi.mock factories below can reference it.

const h = vi.hoisted(() => {
  interface RawEvent { id: string; data: Record<string, unknown> }

  const store = {
    events:        [] as RawEvent[],
    counters:      new Map<string, number>(),
    registrations: 0,
    organizers:    0,
    throwOnEvents: false,
  }

  const docSnap = (e: RawEvent) => ({ id: e.id, exists: true, data: () => e.data })

  const queryStub = (docs: RawEvent[]): Record<string, unknown> => ({
    where:      () => queryStub(docs),
    orderBy:    () => queryStub(docs),
    limit:      (n: number) => queryStub(docs.slice(0, n)),
    startAfter: (cur: { id: string }) => {
      const i = docs.findIndex(d => d.id === cur.id)
      return queryStub(i === -1 ? docs : docs.slice(i + 1))
    },
    get: async () => {
      if (store.throwOnEvents) throw new Error('7 PERMISSION_DENIED: Firestore unavailable')
      const snapshot = docs.map(docSnap)
      return { docs: snapshot, size: snapshot.length, empty: snapshot.length === 0 }
    },
    count: () => ({ get: async () => ({ data: () => ({ count: docs.length }) }) }),
    doc:   (id: string) => ({
      id,
      get: async () => {
        const found = docs.find(d => d.id === id)
        return found ? docSnap(found) : { id, exists: false, data: () => undefined }
      },
    }),
  })

  const adminDb = {
    collection: (name: string) => {
      if (name === 'events') return queryStub(store.events)
      if (name === 'registrations') {
        return queryStub(Array.from({ length: store.registrations }, (_, i) => ({ id: `r${i}`, data: {} })))
      }
      if (name === 'registrationCounters') return { doc: (id: string) => ({ id }) }
      return queryStub([])
    },
    getAll: async (...refs: { id: string }[]) =>
      refs.map(r => ({
        id: r.id,
        exists: store.counters.has(r.id),
        data: () => ({ totalCount: store.counters.get(r.id) ?? 0 }),
      })),
  }

  return { store, adminDb }
})

vi.mock('@/lib/firebase/admin', () => ({ adminDb: h.adminDb }))
vi.mock('@/lib/organizer/identity', () => ({
  organizersQuery: () => ({
    count: () => ({ get: async () => ({ data: () => ({ count: h.store.organizers }) }) }),
  }),
}))

import { listPublishedEvents } from '@/lib/firebase/firestore/publicEvents'

const store = h.store

// ── Fixtures — shaped exactly like a real published event document ────────────

function publishedEvent(over: {
  slug: string; name?: string; city?: string; eventType?: string
  startDate?: string; free?: boolean; online?: boolean
}) {
  return {
    id: over.slug,
    data: {
      lifecycleStatus: 'published',
      eventType: over.eventType ?? 'sports',
      publishedAt: { toDate: () => new Date('2026-08-09T14:39:39.966Z') },
      totalCapacity: 500,
      eventDetails: {
        info:      { name: over.name ?? 'NOYYAL AWARENESS MARATHON 2026', tagline: 'Run for awareness' },
        schedule:  { startDate: over.startDate ?? '2026-08-15', endDate: over.startDate ?? '2026-08-15', startTime: '06:00' },
        venue:     { type: over.online ? 'online' : 'physical', physical: { city: over.city ?? 'Tiruppur', state: 'Tamil Nadu' } },
        media:     { coverBanner: { value: 'https://cdn.example/banner.jpg' }, logo: { value: 'https://cdn.example/logo.png' } },
        organizer: { name: 'UDHAYAM FOUNDATION', logoUrl: 'https://cdn.example/org.png' },
      },
      pricing: over.free
        ? { eventType: 'free', passes: [] }
        : { eventType: 'paid', passes: [{ name: '10K', price: 1, status: 'active' }] },
      registrationForm: { settings: { approvalMode: 'auto' } },
    },
  }
}

beforeEach(() => {
  store.events = []
  store.counters = new Map()
  store.registrations = 0
  store.organizers = 0
  store.throwOnEvents = false
})

// ── 1. The loaded dataset ─────────────────────────────────────────────────────

describe('listPublishedEvents — the loaded dataset', () => {
  it('returns zero events without throwing when nothing is published', async () => {
    const { events, stats, nextCursor } = await listPublishedEvents({ limit: 48 })
    expect(events).toEqual([])
    expect(nextCursor).toBeNull()
    expect(stats.totalEvents).toBe(0)
  })

  it('returns the one published event, fully normalized for the card', async () => {
    store.events = [publishedEvent({ slug: 'noyyal-marathon-2026' })]
    store.counters.set('noyyal-marathon-2026', 5)
    store.registrations = 5
    store.organizers = 1

    const { events, stats } = await listPublishedEvents({ limit: 48 })

    expect(events).toHaveLength(1)
    const e = events[0]
    expect(e.id).toBe('noyyal-marathon-2026')
    expect(e.slug).toBe('noyyal-marathon-2026')
    expect(e.name).toBe('NOYYAL AWARENESS MARATHON 2026')
    expect(e.startDate).toBe('2026-08-15')
    expect(e.city).toBe('Tiruppur')
    expect(e.state).toBe('Tamil Nadu')
    expect(e.venueType).toBe('physical')
    expect(e.eventType).toBe('sports')
    expect(e.bannerUrl).toBe('https://cdn.example/banner.jpg')
    expect(e.organizerName).toBe('UDHAYAM FOUNDATION')
    expect(e.totalCount).toBe(5)
    expect(e.minPrice).toBe(1)
    expect(e.isFreeEvent).toBe(false)
    expect(e.approvalMode).toBe('auto')
    expect(e.publishedAt).toBe('2026-08-09T14:39:39.966Z')
    // The card maps these directly — an undefined would render as a blank field.
    for (const [k, v] of Object.entries(e)) expect(v, `field ${k}`).not.toBeUndefined()

    expect(stats.totalEvents).toBe(1)
  })

  it('returns every published event when there are several', async () => {
    store.events = [
      publishedEvent({ slug: 'a', name: 'Alpha Conference', eventType: 'conference', city: 'Chennai' }),
      publishedEvent({ slug: 'b', name: 'Beta Marathon',    eventType: 'sports',     city: 'Tiruppur' }),
      publishedEvent({ slug: 'c', name: 'Gamma Workshop',   eventType: 'workshop',   city: 'Coimbatore' }),
    ]
    const { events } = await listPublishedEvents({ limit: 48 })
    expect(events.map(e => e.slug)).toEqual(['a', 'b', 'c'])
  })
})

// ── 2. Filtering runs against the dataset and never destroys it ───────────────

describe('filters operate on the dataset without losing it', () => {
  beforeEach(() => {
    store.events = [
      publishedEvent({ slug: 'a', name: 'Alpha Conference', eventType: 'conference', city: 'Chennai' }),
      publishedEvent({ slug: 'b', name: 'Beta Marathon',    eventType: 'sports',     city: 'Tiruppur' }),
      publishedEvent({ slug: 'c', name: 'Gamma Workshop',   eventType: 'workshop',   city: 'Coimbatore', free: true }),
    ]
  })

  it('a category filter narrows the list', async () => {
    const { events } = await listPublishedEvents({ limit: 48, category: 'sports' })
    expect(events.map(e => e.slug)).toEqual(['b'])
  })

  it('a search filter matches name, city and organizer', async () => {
    expect((await listPublishedEvents({ limit: 48, search: 'gamma' })).events.map(e => e.slug)).toEqual(['c'])
    expect((await listPublishedEvents({ limit: 48, search: 'chennai' })).events.map(e => e.slug)).toEqual(['a'])
    expect((await listPublishedEvents({ limit: 48, search: 'udhayam' })).events).toHaveLength(3)
  })

  it('a free filter selects only free events', async () => {
    expect((await listPublishedEvents({ limit: 48, free: true })).events.map(e => e.slug)).toEqual(['c'])
  })

  it('a filter matching nothing returns [] WITHOUT mutating the source dataset', async () => {
    const none = await listPublishedEvents({ limit: 48, search: 'no-such-event-anywhere' })
    expect(none.events).toEqual([])
    // The next unfiltered call must still see all three — filtering is a query, not a
    // mutation. This is the "filters permanently lose the dataset" regression.
    const after = await listPublishedEvents({ limit: 48 })
    expect(after.events.map(e => e.slug)).toEqual(['a', 'b', 'c'])
  })

  it('clearing the filters restores the complete list', async () => {
    await listPublishedEvents({ limit: 48, category: 'sports' })
    const cleared = await listPublishedEvents({ limit: 48 })
    expect(cleared.events).toHaveLength(3)
  })

  it('repeated navigation/refresh yields an identical list every time', async () => {
    const runs = await Promise.all([1, 2, 3, 4, 5].map(() => listPublishedEvents({ limit: 48 })))
    for (const r of runs) expect(r.events.map(e => e.slug)).toEqual(['a', 'b', 'c'])
  })
})

// ── 3. A failed query must NOT masquerade as an empty result ──────────────────

describe('query failure is surfaced, never returned as zero events', () => {
  it('rejects when Firestore fails instead of resolving to []', async () => {
    store.events = [publishedEvent({ slug: 'a' })]
    store.throwOnEvents = true
    await expect(listPublishedEvents({ limit: 48 })).rejects.toThrow(/Firestore unavailable/)
  })

  it('recovers on the next call once Firestore is healthy again', async () => {
    store.events = [publishedEvent({ slug: 'a' })]
    store.throwOnEvents = true
    await expect(listPublishedEvents({ limit: 48 })).rejects.toThrow()

    store.throwOnEvents = false
    const { events } = await listPublishedEvents({ limit: 48 })
    expect(events.map(e => e.slug)).toEqual(['a'])
  })
})
