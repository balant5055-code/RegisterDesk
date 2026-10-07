// The landing page's filters, asserted as a round-trip.
//
// The URL is the durable copy of what a visitor asked for. These tests pin the two rules that
// make that true — REPAIR NEVER TRUST on the way in, DEFAULTS OMITTED on the way out — plus
// the compatibility alias that keeps existing /events?type=<id> links working.
//
// The module is pure, so this needs no router, no DOM and no Firebase.

import { describe, it, expect } from 'vitest'
import {
  PARAM, DEFAULT_URL_STATE, MAX_QUERY_LEN,
  parseDiscoveryParams, serializeDiscoveryState, discoveryHref,
  nextUrlState, isDefaultState, activeFilterCount,
} from '@/lib/discovery/urlState'
import { DISCOVERY_CATEGORIES } from '@/components/marketing/discovery/discoveryTaxonomy'

const parse = (qs: string) => parseDiscoveryParams(new URLSearchParams(qs))

describe('parsing repairs the URL rather than trusting it', () => {
  it('reads a fully-specified search', () => {
    const s = parse('q=marathon&category=sports&city=Chennai&venue=online&price=free&date=weekend&sort=popular')
    expect(s.query).toBe('marathon')
    expect(s.category).toBe('sports')
    expect(s.city).toBe('Chennai')
    expect(s.venue).toBe('online')
    expect(s.price).toBe('free')
    expect(s.date).toBe('weekend')
    expect(s.sort).toBe('popular')
  })

  it('drops a category that is not a real eventType id', () => {
    // The taxonomy file records this exact bug shipping once: chips filtered on 'marathon'
    // and 'startup', which are not eventType ids, so every one returned an empty result set.
    expect(parse('category=marathon').category).toBe('')
    expect(parse('category=startup').category).toBe('')
    expect(parse('category=%3Cscript%3E').category).toBe('')
  })

  it('accepts every real category id', () => {
    for (const c of DISCOVERY_CATEGORIES) {
      expect(parse(`category=${c.id}`).category).toBe(c.id)
    }
  })

  it('drops an unknown venue, price, date and sort', () => {
    const s = parse('venue=teleport&price=cheap&date=someday&sort=random')
    expect(s.venue).toBeNull()
    expect(s.price).toBeNull()
    expect(s.date).toBeNull()
    expect(s.sort).toBe('recommended')
  })

  it('caps an oversized query instead of forwarding it to a server scan', () => {
    expect(parse(`q=${'a'.repeat(500)}`).query).toHaveLength(MAX_QUERY_LEN)
  })

  it('rejects a cursor that is a document PATH rather than an id', () => {
    // An unvalidated cursor reaches collection.doc(cursor); a value containing '/' is read as
    // a path and Firestore throws on an odd segment count.
    expect(parse('cursor=a/b/c').cursor).toBeNull()
    expect(parse('cursor=../../etc').cursor).toBeNull()
    expect(parse('cursor=noyyal-marathon-2026').cursor).toBe('noyyal-marathon-2026')
  })

  it('only accepts ISO days for a custom window', () => {
    expect(parse('date=custom&from=2026-09-01&to=2026-09-30').from).toBe('2026-09-01')
    expect(parse('date=custom&from=01-09-2026').from).toBe('')
  })

  it('normalises a state to the catalog casing', () => {
    expect(parse('state=tamil%20nadu').state).toBe('Tamil Nadu')
    expect(parse('state=Atlantis').state).toBe('')
  })

  it('takes the first value when a parameter is repeated', () => {
    expect(parse('category=sports&category=conference').category).toBe('sports')
  })

  it('reads Next-style searchParams objects, including array values', () => {
    expect(parseDiscoveryParams({ category: 'workshop' }).category).toBe('workshop')
    expect(parseDiscoveryParams({ category: ['meetup', 'awards'] }).category).toBe('meetup')
    expect(parseDiscoveryParams({}).category).toBe('')
  })
})

describe('the ?type= alias keeps existing event-detail breadcrumbs working', () => {
  it('honours type when category is absent', () => {
    // lib/events/breadcrumbs.ts emits /events?type=<eventType> from every event page and is
    // deliberately not modified, so the alias has to be understood on this side.
    expect(parse(`${PARAM.typeAlias}=sports`).category).toBe('sports')
  })

  it('lets the canonical category win when both are present', () => {
    expect(parse('category=workshop&type=sports').category).toBe('workshop')
  })

  it('never writes the alias back out', () => {
    const s = parse('type=sports')
    expect(serializeDiscoveryState(s)).toBe('category=sports')
  })
})

describe('serialising omits defaults so one state is one URL', () => {
  it('the unfiltered state is the bare path, never a trailing ?', () => {
    expect(serializeDiscoveryState(DEFAULT_URL_STATE)).toBe('')
    expect(discoveryHref(DEFAULT_URL_STATE)).toBe('/')
    expect(discoveryHref(DEFAULT_URL_STATE, '/events')).toBe('/events')
  })

  it('omits the default sort but keeps a chosen one', () => {
    expect(serializeDiscoveryState({ ...DEFAULT_URL_STATE, sort: 'recommended' })).toBe('')
    expect(serializeDiscoveryState({ ...DEFAULT_URL_STATE, sort: 'popular' })).toBe('sort=popular')
  })

  it('drops from/to unless the range is actually custom', () => {
    const named = serializeDiscoveryState({ ...DEFAULT_URL_STATE, date: 'weekend', from: '2026-09-01', to: '2026-09-30' })
    expect(named).toBe('date=weekend')
    const custom = serializeDiscoveryState({ ...DEFAULT_URL_STATE, date: 'custom', from: '2026-09-01', to: '2026-09-30' })
    expect(custom).toContain('date=custom')
    expect(custom).toContain('from=2026-09-01')
  })

  it('round-trips a populated state unchanged', () => {
    const qs = 'q=summit&category=conference&city=Chennai&state=Tamil+Nadu&venue=hybrid&price=paid&date=month&sort=soonest'
    expect(serializeDiscoveryState(parse(qs))).toBe(serializeDiscoveryState(parse(serializeDiscoveryState(parse(qs)))))
  })

  it('is stable — the same state always produces the same string', () => {
    const a = parse('category=sports&q=run')
    const b = parse('q=run&category=sports')
    expect(serializeDiscoveryState(a)).toBe(serializeDiscoveryState(b))
  })
})

describe('nextUrlState protects pagination from stale cursors', () => {
  it('drops the cursor when a filter changes', () => {
    // Page 2 of the previous query is meaningless for a different query, and carrying it over
    // is exactly how a filter change silently lands on an empty page.
    const cur = { ...DEFAULT_URL_STATE, cursor: 'abc' }
    expect(nextUrlState(cur, { category: 'sports' }).cursor).toBeNull()
    expect(nextUrlState(cur, { query: 'run' }).cursor).toBeNull()
  })

  it('keeps the cursor when only the sort changes', () => {
    const cur = { ...DEFAULT_URL_STATE, cursor: 'abc' }
    expect(nextUrlState(cur, { sort: 'popular' }).cursor).toBe('abc')
  })

  it('sets an explicit cursor when one is supplied', () => {
    expect(nextUrlState(DEFAULT_URL_STATE, { cursor: 'next-page' }).cursor).toBe('next-page')
  })
})

describe('state predicates', () => {
  it('recognises the unfiltered state', () => {
    expect(isDefaultState(DEFAULT_URL_STATE)).toBe(true)
    expect(isDefaultState(parse('q=x'))).toBe(false)
    // sort is a view control, not a filter, so it does not make the page "filtered".
    expect(isDefaultState(parse('sort=popular'))).toBe(false)
  })

  it('counts filters but not sort', () => {
    expect(activeFilterCount(DEFAULT_URL_STATE)).toBe(0)
    expect(activeFilterCount(parse('sort=popular'))).toBe(0)
    expect(activeFilterCount(parse('q=run&category=sports&city=Chennai'))).toBe(3)
  })
})
