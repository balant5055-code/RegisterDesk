// RD-ORG-FOUNDATION · Selected-event context — the PURE half.
//
// Everything here is a pure function over plain data: no React, no Firebase, no
// Admin SDK. That split is deliberate and matches the precedent set by
// lib/team/types.ts (the role matrix lives away from lib/team/access.ts precisely
// because the latter boots the Admin SDK at import time and cannot be exercised in
// the repo's node-environment vitest run).
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// The selected event is a UX affordance, NOT a security boundary. Nothing here
// grants access to anything. Every event-scoped request is re-authorized on the
// server through authorizeWorkspace + a workspace-scoped Firestore path
// (`users/{workspaceUid}/eventDrafts/{eventId}`), so a caller who forges the
// `?event=` parameter reaches exactly the 404 they would have reached anyway.
//
// The one rule this module DOES enforce is that a remembered id is never trusted:
// resolveSelectedEvent only ever returns an id that is present in the caller's own
// authorized event list. A stale localStorage entry from a workspace the caller has
// since been removed from resolves to null, not to that event.

/**
 * The lightweight shape the shell needs to render the selector, the breadcrumbs and
 * the overview header.
 *
 * This is a strict SUBSET of `EventListItem` from GET /api/organizer/events, which
 * already returns exactly these fields from `registrationCounters` (the canonical
 * counting SSOT) — so the shell adds ZERO Firestore reads over what the Events page
 * already costs. Nothing here requires a registration scan.
 */
export interface EventSummary {
  draftId:            string
  name:               string
  slug:               string | null
  status:             'draft' | 'published'
  lifecycleStatus:    string
  startDate:          string | null
  endDate:            string | null
  totalRegistrations: number
  totalCapacity:      number | null
  updatedAt:          string
  /**
   * The event's OWN configured taxonomy ids, already present in the events-list payload.
   * Carried here so the shell can name the category beside the selector without a second
   * request. Null when the event has none — never inferred.
   */
  eventType?:         string | null
  eventSubtype?:      string | null
}

/**
 * Query parameter that carries the selected event on event-scoped routes.
 *
 * `eventId`, not `event`, deliberately: `/dashboard/registrations?eventId=` is the
 * convention already in the product, and it matches the `[eventId]` path segment the
 * event workspace uses. Introducing `?event=` would have created a second spelling of
 * the same idea — the precise failure this whole context exists to remove — and would
 * have silently broken the one page already reading `eventId`.
 */
export const EVENT_PARAM = 'eventId'

/** localStorage key for the last selected event. Validated on every read — never trusted. */
export const EVENT_STORAGE_KEY = 'rd_selected_event_id'

// ─── Lifecycle grouping ───────────────────────────────────────────────────────

/**
 * Lifecycle states that represent an event an organizer is actively operating.
 *
 * Derived from the values `deriveLifecycleStatus` produces (lib/events/lifecycle.ts).
 * Used only to RANK candidates for the default selection — never to hide an event
 * from the selector, because an organizer must always be able to reach a completed
 * or cancelled event to pull its reports.
 */
const ACTIVE_LIFECYCLE = new Set(['published', 'registration_closed'])
const DORMANT_LIFECYCLE = new Set(['cancelled', 'archived'])

export function isActiveEvent(e: EventSummary): boolean {
  return ACTIVE_LIFECYCLE.has(e.lifecycleStatus)
}

// ─── Default-selection ranking ────────────────────────────────────────────────

function startMs(e: EventSummary): number {
  if (!e.startDate) return Number.NaN
  const t = Date.parse(e.startDate)
  return Number.isNaN(t) ? Number.NaN : t
}

function updatedMs(e: EventSummary): number {
  const t = Date.parse(e.updatedAt)
  return Number.isNaN(t) ? 0 : t
}

/**
 * Ranks the caller's events into the order the product wants for a first visit:
 *
 *   1. live now      — active lifecycle, started, not yet finished
 *   2. upcoming      — active lifecycle, starts in the future (soonest first)
 *   3. active, undated
 *   4. everything else, most recently touched first
 *   5. cancelled / archived last — never auto-selected over a working event
 *
 * `now` is injected rather than read from the clock so this is deterministic under
 * test. (Workflow scripts aside, the repo's vitest run has no fake timers wired, and
 * a function that reads Date.now() internally cannot be asserted on.)
 */
export function rankEventsForDefault(events: EventSummary[], now: number): EventSummary[] {
  const bucket = (e: EventSummary): number => {
    if (DORMANT_LIFECYCLE.has(e.lifecycleStatus)) return 4
    const s = startMs(e)
    const end = e.endDate ? Date.parse(e.endDate) : Number.NaN
    const active = isActiveEvent(e)
    if (active && !Number.isNaN(s) && s <= now && (Number.isNaN(end) || end >= now)) return 0
    if (active && !Number.isNaN(s) && s > now) return 1
    if (active) return 2
    return 3
  }

  return [...events].sort((a, b) => {
    const ba = bucket(a)
    const bb = bucket(b)
    if (ba !== bb) return ba - bb

    // Upcoming: soonest first. Everything else: most recently touched first.
    if (ba === 1) {
      const sa = startMs(a)
      const sb = startMs(b)
      if (!Number.isNaN(sa) && !Number.isNaN(sb) && sa !== sb) return sa - sb
    }
    return updatedMs(b) - updatedMs(a)
  })
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * The explicit "All events" selection.
 *
 * ═══ WHY A SENTINEL AND NOT JUST `null` ═══════════════════════════════════════
 * `eventId: null` already meant "nothing is selected or selectable" — a brand-new
 * organizer with no events. "The organizer deliberately chose all events" is a DIFFERENT
 * state that happens to produce the same scope, and the two must stay distinguishable:
 * only the deliberate one may be remembered and restored on the next visit. Collapsing
 * them would make an empty workspace look like a chosen scope, and would make the choice
 * unrememberable.
 *
 * So the CHOICE is carried as this sentinel through storage and the URL, and
 * `resolveSelectedEvent` turns it into `{ eventId: null, source: 'all' }`. Downstream
 * consumers keep reading `selectedEventId`, which stays `string | null` — no consumer
 * has to learn a new shape, and the dashboard's existing "no eventId ⇒ all events"
 * request already does the right thing.
 *
 * Double underscores match the `ALL_EVENTS` sentinel in lib/dashboard/dailyStats.ts so the
 * vocabulary is consistent, but they are deliberately separate constants: one is a client
 * selection, the other a Firestore document key, and coupling them would tie a UI choice
 * to a storage layout.
 */
export const ALL_EVENTS_SELECTION = '__all__'

/** True when a stored/URL value is the explicit all-events choice rather than an event id. */
export function isAllEventsSelection(value: string | null | undefined): boolean {
  return value === ALL_EVENTS_SELECTION
}

export type EventSelectionSource = 'url' | 'stored' | 'default' | 'none' | 'all'

export interface EventSelectionInput {
  /** Event id carried by the URL (path segment or `?event=`). */
  urlEventId: string | null
  /** Event id remembered from a previous session. NEVER trusted on its own. */
  storedEventId: string | null
  /** The caller's authorized events, exactly as the server returned them. */
  events: EventSummary[]
  now: number
}

export interface EventSelection {
  /**
   * The selected event, or null.
   *
   * Null means EITHER the explicit all-events choice (`source: 'all'`) or nothing
   * selectable (`source: 'none'`). Read `source` to tell them apart.
   */
  eventId: string | null
  source:  EventSelectionSource
  /**
   * True when the URL named an event that is NOT in the caller's authorized list.
   *
   * The distinction matters for the UI: a bad `?event=` should show "this event is
   * not available" rather than silently swapping the organizer onto a different
   * event's data, which is how cross-event confusion starts.
   */
  urlEventMissing: boolean
}

/**
 * THE canonical selected-event decision. One function, one priority order, used by
 * the provider on first load and on every navigation.
 *
 *   1. a valid event named by the URL
 *   2. the remembered event, IF it is still in the authorized list
 *   3. the best default by rank (live → upcoming → active → recent)
 *   4. nothing (empty workspace → empty state)
 *
 * Steps 1 and 2 both membership-test against `events`, which is the caller's own
 * authorized list from the server. That is what makes a forged or stale id inert
 * here rather than merely inert later.
 */
export function resolveSelectedEvent(input: EventSelectionInput): EventSelection {
  const { urlEventId, storedEventId, events, now } = input
  const known = new Set(events.map(e => e.draftId))

  if (urlEventId) {
    // The explicit all-events choice, carried in the URL so Back/Forward move it like any
    // other selection. Checked BEFORE `known.has`, since the sentinel is not a draft id and
    // would otherwise be treated as a missing event.
    if (isAllEventsSelection(urlEventId)) return { eventId: null, source: 'all', urlEventMissing: false }
    if (known.has(urlEventId)) return { eventId: urlEventId, source: 'url', urlEventMissing: false }
    // Do NOT fall through to a different event: the organizer asked for a specific
    // one, and quietly showing another event's numbers under that URL is worse than
    // an empty state. The list still loads so they can pick.
    return { eventId: null, source: 'none', urlEventMissing: true }
  }

  // A REMEMBERED all-events choice. Also before `known.has`, and deliberately ahead of the
  // default ranking: having chosen all-events last time, an organizer must not be silently
  // put back onto one event on their next visit.
  if (isAllEventsSelection(storedEventId)) {
    return { eventId: null, source: 'all', urlEventMissing: false }
  }

  if (storedEventId && known.has(storedEventId)) {
    return { eventId: storedEventId, source: 'stored', urlEventMissing: false }
  }

  const best = rankEventsForDefault(events, now)[0]
  return best
    ? { eventId: best.draftId, source: 'default', urlEventMissing: false }
    : { eventId: null, source: 'none', urlEventMissing: false }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

/**
 * Reads the event id a pathname encodes as a PATH segment.
 *
 * Only `/dashboard/events/{id}` carries the event in the path. Everything else uses
 * `?event=`. This is the deliberate compromise recorded in the foundation plan: the
 * platform has ~61 organizer pages and rewriting every route into
 * `/dashboard/events/{id}/{module}` would touch every link, every API caller and
 * every deep link in the product for no security or correctness gain.
 */
export function eventIdFromPathname(pathname: string): string | null {
  const m = /^\/dashboard\/events\/([^/?#]+)/.exec(pathname)
  if (!m) return null
  const id = m[1]
  // `new` is the wizard, not an event id.
  if (id === 'new') return null
  return decodeURIComponent(id)
}

/** True when this route's data is scoped to the selected event. */
export function isEventScopedPath(pathname: string, eventScopedPrefixes: readonly string[]): boolean {
  return eventScopedPrefixes.some(p => pathname === p || pathname.startsWith(`${p}/`))
}

/**
 * Builds an href that carries the selected event, without disturbing any other
 * query parameter the destination already relies on (`?status=`, `?filter=`, …).
 *
 * A `null` eventId strips the parameter rather than writing "null" into the URL.
 */
export function withEventParam(href: string, eventId: string | null): string {
  const [base, hash = ''] = href.split('#')
  const [path, query = ''] = base.split('?')
  const params = new URLSearchParams(query)
  if (eventId) params.set(EVENT_PARAM, eventId)
  else params.delete(EVENT_PARAM)
  const qs = params.toString()
  return `${path}${qs ? `?${qs}` : ''}${hash ? `#${hash}` : ''}`
}

// ─── Display helpers ──────────────────────────────────────────────────────────

export interface EventStatusPresentation {
  label: string
  /** Semantic tone — mapped to tokens by the component, never a raw colour here. */
  tone:  'live' | 'upcoming' | 'draft' | 'closed' | 'done' | 'stopped'
}

/**
 * ONE mapping from lifecycle status to what the organizer reads. Shared by the
 * selector, the breadcrumb trail and the event overview so those three can never
 * describe the same event differently — the failure mode that makes a dashboard
 * feel untrustworthy.
 */
export function presentEventStatus(e: EventSummary, now: number): EventStatusPresentation {
  switch (e.lifecycleStatus) {
    case 'cancelled': return { label: 'Cancelled', tone: 'stopped' }
    case 'archived':  return { label: 'Archived',  tone: 'stopped' }
    case 'completed': return { label: 'Completed', tone: 'done' }
    case 'registration_closed': return { label: 'Registration closed', tone: 'closed' }
    case 'published': {
      const s = startMs(e)
      if (!Number.isNaN(s) && s > now) return { label: 'Upcoming', tone: 'upcoming' }
      return { label: 'Live', tone: 'live' }
    }
    default: return { label: 'Draft', tone: 'draft' }
  }
}

/** Fill percentage, or null when the event has no capacity configured (unlimited). */
export function fillPercent(e: EventSummary): number | null {
  if (!e.totalCapacity || e.totalCapacity <= 0) return null
  return Math.min(100, Math.round((e.totalRegistrations / e.totalCapacity) * 100))
}
