// RD-EVENT-02 §3 · Events landing — the page's state, expressed as a URL.
//
// The query string is the durable copy; React state only mirrors it. That is what makes
// Back/Forward, refresh and link-sharing work, and it is what stops a mutation from
// dumping the organizer back on the default tab: a refetch keeps the URL, so it keeps
// the tab, the search and the page.
//
// Pure module — parsing and serialising only, no hooks — so the round-trip is testable
// without a router.

import { parseListingTab, type EventListingTabKey } from '@/lib/events/listingTabs'

/** Query parameter names. `tab` and `search` already match what the LIST API accepts. */
export const PARAM = {
  tab:      'tab',
  search:   'search',
  page:     'page',
  pageSize: 'pageSize',
} as const

export const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const
export const DEFAULT_PAGE_SIZE = 10
export const DEFAULT_TAB: EventListingTabKey = 'active'

/** How deep a URL may ask the list to restore in one go. See `parseUrlState`. */
export const MAX_RESTORABLE_PAGE = 50

export interface EventsUrlState {
  tab:      EventListingTabKey
  search:   string
  /** 1-based, as it appears in the URL. Internally the list works 0-based. */
  page:     number
  pageSize: number
}

export const DEFAULT_URL_STATE: EventsUrlState = {
  tab:      DEFAULT_TAB,
  search:   '',
  page:     1,
  pageSize: DEFAULT_PAGE_SIZE,
}

/**
 * Read state out of a query string, repairing anything invalid rather than trusting it.
 *
 * `tab` goes through `parseListingTab`, the listing SSOT, so an unknown tab in a
 * hand-edited URL falls back to the default instead of producing a filter the server
 * would reject. None of these values is ever an authorization input — the server derives
 * ownership from the session, never from the query string.
 */
export function parseUrlState(params: URLSearchParams): EventsUrlState {
  const tab = parseListingTab(params.get(PARAM.tab)) ?? DEFAULT_TAB

  // Clamped, because restoring page N over a CURSOR-paginated list means walking N pages:
  // an unclamped `?page=99999` would fire 99999 sequential requests. This is a client
  // fetch bound, not a product rule — it caps how deep a hand-edited URL can ask us to
  // walk, and normal Next/Prev paging can still travel past it one page at a time.
  const rawPage = Number(params.get(PARAM.page))
  const page = Number.isFinite(rawPage) && rawPage >= 1
    ? Math.min(Math.floor(rawPage), MAX_RESTORABLE_PAGE)
    : 1

  const rawSize = Number(params.get(PARAM.pageSize))
  const pageSize = (PAGE_SIZE_OPTIONS as readonly number[]).includes(rawSize)
    ? rawSize
    : DEFAULT_PAGE_SIZE

  return { tab, search: (params.get(PARAM.search) ?? '').trim(), page, pageSize }
}

/**
 * Serialise back to a query string, omitting defaults.
 *
 * Omission keeps `/dashboard/events` clean for the common case and keeps the URL stable:
 * writing `?tab=active&page=1` on first paint would push a history entry that the user
 * never asked for, so Back would appear broken before they had done anything.
 */
export function serializeUrlState(state: EventsUrlState): string {
  const params = new URLSearchParams()
  if (state.tab !== DEFAULT_TAB)            params.set(PARAM.tab, state.tab)
  if (state.search)                         params.set(PARAM.search, state.search)
  if (state.page > 1)                       params.set(PARAM.page, String(state.page))
  if (state.pageSize !== DEFAULT_PAGE_SIZE) params.set(PARAM.pageSize, String(state.pageSize))
  return params.toString()
}

/** `/dashboard/events` plus the serialised state — what gets pushed to the router. */
export function eventsHref(state: EventsUrlState): string {
  const qs = serializeUrlState(state)
  return qs ? `/dashboard/events?${qs}` : '/dashboard/events'
}

/**
 * Which changes reset the page back to 1.
 *
 * Changing the tab, the search or the page size changes WHICH events are being listed, so
 * holding the old page number would land the organizer on an out-of-range window and show
 * them an empty grid for a tab that has results.
 */
export function nextUrlState(
  current: EventsUrlState,
  patch: Partial<EventsUrlState>,
): EventsUrlState {
  const merged = { ...current, ...patch }
  const resets = patch.tab !== undefined && patch.tab !== current.tab
    || patch.search !== undefined && patch.search !== current.search
    || patch.pageSize !== undefined && patch.pageSize !== current.pageSize
  return resets && patch.page === undefined ? { ...merged, page: 1 } : merged
}
