// ─── Discovery URL state — the page's filters, expressed as a query string ───
//
// The query string is the DURABLE copy of what the visitor asked for; React state only
// mirrors it. That is what makes Back/Forward, refresh, link-sharing and crawling work, and
// it is the defect this module exists to close: the staging /events page holds its filters
// in useState alone, so nothing about a search survives a reload or can be sent to anyone.
//
// PURE by design — parsing and serialising only, no hooks, no router, no Firebase. The
// round-trip is therefore testable without a DOM, and the same module can be read by a
// server component (to render the correct HTML on first paint) and by a client island
// (to keep the URL in step) without either one owning the rules.
//
// Mirrors the established house pattern in app/(dashboard)/dashboard/events/urlState.ts.
//
// ═══ TWO RULES WORTH STATING ═════════════════════════════════════════════════
//
// REPAIR, NEVER TRUST. Every value is validated against a real catalog and silently dropped
// when it is not recognised, so a hand-edited or stale URL degrades to a broader search
// rather than producing a filter the server would reject. Nothing parsed here is ever an
// authorization input — the published/moderation/visibility gates live in the data layer and
// are unconditional.
//
// DEFAULTS ARE OMITTED. The unfiltered view serialises to the empty string, so the landing
// page's canonical URL is exactly `/` and never `/?q=&sort=recommended`. One state, one URL.

import { DATE_LABEL, DISCOVERY_CATEGORIES, SORT_OPTIONS } from '@/components/marketing/discovery/discoveryTaxonomy'
import type { DateKey, SortKey, VenueKey } from '@/components/marketing/discovery/discoveryTaxonomy'
import { INDIA_STATES } from '@/components/marketing/discovery/indiaGeo'

/** Query-parameter names. Short, readable, and stable — they appear in shared links. */
export const PARAM = {
  query:    'q',
  category: 'category',
  /** Read-only alias for `category`, so the existing /events?type=<id> breadcrumb keeps working. */
  typeAlias: 'type',
  city:     'city',
  state:    'state',
  venue:    'venue',
  price:    'price',
  date:     'date',
  from:     'from',
  to:       'to',
  sort:     'sort',
  cursor:   'cursor',
} as const

/** Caps that keep a hand-crafted URL from becoming an unbounded server scan. */
export const MAX_QUERY_LEN = 80
export const MAX_CITY_LEN  = 60

const CATEGORY_IDS = new Set(DISCOVERY_CATEGORIES.map(c => c.id))
const SORT_KEYS    = new Set(SORT_OPTIONS.map(o => o.key as string))
const DATE_KEYS    = new Set(Object.keys(DATE_LABEL))
const VENUE_KEYS   = new Set(['physical', 'online', 'hybrid'])
const STATE_BY_LOWER = new Map(INDIA_STATES.map(s => [s.toLowerCase(), s]))

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
/**
 * A cursor is a DOCUMENT ID that reaches `collection.doc(cursor)`. A value containing '/'
 * would be read as a document PATH instead, so the shape is constrained here as well as at
 * the API boundary.
 */
const CURSOR = /^[A-Za-z0-9_-]{1,200}$/

export type PriceKey = 'free' | 'paid'

export interface DiscoveryUrlState {
  query:    string
  category: string
  city:     string
  state:    string
  venue:    VenueKey | null
  price:    PriceKey | null
  date:     DateKey | null
  from:     string
  to:       string
  sort:     SortKey
  cursor:   string | null
}

export const DEFAULT_URL_STATE: DiscoveryUrlState = {
  query: '', category: '', city: '', state: '',
  venue: null, price: null, date: null, from: '', to: '',
  sort: 'recommended', cursor: null,
}

/** True when nothing is being filtered — i.e. this state serialises to the bare landing URL. */
export function isDefaultState(s: DiscoveryUrlState): boolean {
  return !s.query && !s.category && !s.city && !s.state &&
    !s.venue && !s.price && !s.date && s.sort === 'recommended' && !s.cursor
}

/** How many FILTERS are active. `sort` is a view control and deliberately not counted. */
export function activeFilterCount(s: DiscoveryUrlState): number {
  return [s.query, s.category, s.city, s.state, s.venue, s.price, s.date].filter(Boolean).length
}

type Params = URLSearchParams | Record<string, string | string[] | undefined>

function read(p: Params, key: string): string {
  if (p instanceof URLSearchParams) return p.get(key) ?? ''
  const v = p[key]
  // Next hands a repeated param through as an array; the first occurrence wins so that
  // `?category=a&category=b` narrows to one real value instead of failing validation.
  return (Array.isArray(v) ? v[0] : v) ?? ''
}

/**
 * Read state out of a query string, repairing anything invalid rather than trusting it.
 *
 * Accepts either a `URLSearchParams` (client) or Next's resolved `searchParams` object
 * (server), so one implementation serves both sides of the boundary.
 */
export function parseDiscoveryParams(params: Params): DiscoveryUrlState {
  const raw = (k: string) => read(params, k).trim()

  const category = raw(PARAM.category).toLowerCase()
  // `type` is honoured on the way IN and never written on the way out, so a legacy link keeps
  // working without the alias ever competing with the canonical parameter.
  const alias    = raw(PARAM.typeAlias).toLowerCase()
  const resolvedCategory = CATEGORY_IDS.has(category) ? category
    : CATEGORY_IDS.has(alias) ? alias
      : ''

  const venue = raw(PARAM.venue).toLowerCase()
  const price = raw(PARAM.price).toLowerCase()
  const date  = raw(PARAM.date).toLowerCase()
  const sort  = raw(PARAM.sort).toLowerCase()
  const stateRaw = raw(PARAM.state)
  const cursor = raw(PARAM.cursor)

  return {
    query:    raw(PARAM.query).slice(0, MAX_QUERY_LEN),
    category: resolvedCategory,
    city:     raw(PARAM.city).slice(0, MAX_CITY_LEN),
    // Normalised back to the catalog's own casing so the value matches what the picker shows.
    state:    STATE_BY_LOWER.get(stateRaw.toLowerCase()) ?? '',
    venue:    VENUE_KEYS.has(venue) ? (venue as VenueKey) : null,
    price:    price === 'free' || price === 'paid' ? (price as PriceKey) : null,
    date:     DATE_KEYS.has(date) ? (date as DateKey) : null,
    from:     ISO_DAY.test(raw(PARAM.from)) ? raw(PARAM.from) : '',
    to:       ISO_DAY.test(raw(PARAM.to)) ? raw(PARAM.to) : '',
    sort:     SORT_KEYS.has(sort) ? (sort as SortKey) : 'recommended',
    cursor:   CURSOR.test(cursor) ? cursor : null,
  }
}

/**
 * State → query string, with defaults omitted and a stable key order.
 *
 * Stable order matters: the same state must always produce the same string, or a re-render
 * writes a "different" URL and pushes a spurious history entry.
 */
export function serializeDiscoveryState(s: DiscoveryUrlState): string {
  const p = new URLSearchParams()
  if (s.query)    p.set(PARAM.query, s.query)
  if (s.category) p.set(PARAM.category, s.category)
  if (s.city)     p.set(PARAM.city, s.city)
  if (s.state)    p.set(PARAM.state, s.state)
  if (s.venue)    p.set(PARAM.venue, s.venue)
  if (s.price)    p.set(PARAM.price, s.price)
  if (s.date) {
    p.set(PARAM.date, s.date)
    // from/to describe a custom window and are meaningless attached to a named range.
    if (s.date === 'custom') {
      if (s.from) p.set(PARAM.from, s.from)
      if (s.to)   p.set(PARAM.to, s.to)
    }
  }
  if (s.sort !== 'recommended') p.set(PARAM.sort, s.sort)
  if (s.cursor) p.set(PARAM.cursor, s.cursor)
  return p.toString()
}

/** A shareable href for this state. The unfiltered state is the bare path, never `path?`. */
export function discoveryHref(s: DiscoveryUrlState, path = '/'): string {
  const qs = serializeDiscoveryState(s)
  return qs ? `${path}?${qs}` : path
}

/**
 * A new state with `patch` applied.
 *
 * Any change to a FILTER drops the cursor: page 2 of the previous query has no meaning for a
 * different query, and carrying it over is how a filter change silently returns an empty page.
 * Changing only `sort` or only `cursor` leaves the cursor alone.
 */
export function nextUrlState(
  current: DiscoveryUrlState,
  patch: Partial<DiscoveryUrlState>,
): DiscoveryUrlState {
  const touchesFilter = (
    ['query', 'category', 'city', 'state', 'venue', 'price', 'date', 'from', 'to'] as const
  ).some(k => k in patch)
  return {
    ...current,
    ...patch,
    cursor: 'cursor' in patch ? patch.cursor ?? null : touchesFilter ? null : current.cursor,
  }
}
