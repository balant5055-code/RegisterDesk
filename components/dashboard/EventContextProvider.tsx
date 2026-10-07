'use client'

// RD-ORG-FOUNDATION · Selected-event context — the REACT half.
//
// THE one selected-event state in the organizer portal. Mounted once in
// app/(dashboard)/layout.tsx; every event-scoped surface reads from here.
//
// ═══ WHY ONE CONTEXT, AND WHY IT HOLDS SO LITTLE ═════════════════════════════
// Before this, "which event am I looking at?" was answered independently by the
// dashboard's EventSwitcher, each page's own `?eventId=` reader, and the command
// palette. Three answers meant they could disagree, and the URL agreed with none of
// them after a switch.
//
// This context holds the SUMMARY LIST and the SELECTED ID. Nothing else. It never
// holds registrations, participants, finance, certificates or BIBs — modules fetch
// their own data, scoped to `selectedEventId`. That boundary is what keeps switching
// events cheap: one selector change must not invalidate megabytes of module state,
// and the context must never become a place where a module's data is cached behind
// another module's back.
//
// ═══ FIREBASE COST ═══════════════════════════════════════════════════════════
// Exactly ONE request per session: GET /api/organizer/events?limit=100. That route
// is cursor-paginated and takes its counts from `registrationCounters` (the
// canonical counting SSOT) — it performs no registration scan. The Events page
// already made this call, so the shell adds no new read pattern; it reuses the same
// endpoint and shares the result with every consumer.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// Not a security boundary. See the header of lib/events/eventContext.ts.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import {
  EVENT_PARAM, EVENT_STORAGE_KEY, eventIdFromPathname, isEventScopedPath,
  resolveSelectedEvent, withEventParam, ALL_EVENTS_SELECTION, isAllEventsSelection,
  type EventSummary,
} from '@/lib/events/eventContext'
import { EVENT_SCOPED_PREFIXES, ALL_EVENTS_HREF } from '@/config/workspaceNav'
import type { EventsListResponse } from '@/app/api/organizer/events/route'

// How many events the selector holds. Well above any realistic organizer's event
// count, and one request either way — the route caps `limit` at 100 itself.
const EVENT_PAGE_SIZE = 100

export interface EventContextValue {
  /** The caller's authorized events, lightweight summaries only. */
  events:          EventSummary[]
  /**
   * Currently selected event id, or null.
   *
   * Null means EITHER the explicit "All events" choice or nothing selectable — read
   * `isAllEvents` to tell them apart. Consumers that only need the request scope can keep
   * reading this alone: both cases correctly mean "do not filter to one event".
   */
  selectedEventId: string | null
  /**
   * True when the organizer explicitly chose "All events".
   *
   * Distinct from `selectedEventId === null`, which is also true for a brand-new workspace
   * with no events at all. Surfaces so a page can say "All events" rather than "no event".
   */
  isAllEvents:     boolean
  /** Resolved summary for `selectedEventId`. Null while loading or when none. */
  selectedEvent:   EventSummary | null
  loading:         boolean
  error:           string | null
  /** True when the URL named an event this caller cannot reach. */
  urlEventMissing: boolean
  /**
   * Select an event and reflect it in the URL.
   *
   * Pass `ALL_EVENTS_SELECTION` to choose the workspace-wide scope.
   */
  selectEvent:     (eventId: string) => void
  /** Re-fetch the summary list (after create/publish/delete). */
  refresh:         () => void
  /**
   * Monotonic counter, bumped on every selection change.
   *
   * Modules pass this to `useEventScopedData` so a response from the previous event
   * can be discarded instead of painting over the current one.
   */
  generation:      number
  /**
   * ONE clock for the whole shell, captured at mount.
   *
   * Every "is this event live or upcoming?" decision reads this instead of calling
   * Date.now() itself. Two reasons, and the second is the real one:
   *   • Date.now() during render is impure, and React 19 rejects it.
   *   • Independent clocks drift across a midnight or a status boundary, so the
   *     selector could label an event "Upcoming" while the overview beside it says
   *     "Live". One clock makes that impossible.
   */
  now:             number
}

const EventCtx = createContext<EventContextValue | null>(null)

function readStoredEventId(): string | null {
  try { return window.localStorage.getItem(EVENT_STORAGE_KEY) } catch { return null }
}

function writeStoredEventId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(EVENT_STORAGE_KEY, id)
    else window.localStorage.removeItem(EVENT_STORAGE_KEY)
  } catch { /* private mode / blocked storage — selection still works for this session */ }
}

export function EventContextProvider({ children }: { children: React.ReactNode }) {
  const { user, getToken } = useAuth()
  const router       = useRouter()
  const pathname     = usePathname()
  const searchParams = useSearchParams()

  // ONE settled result stamped with the load it came from, so `loading` is DERIVED
  // rather than assigned. Same reasoning as lib/hooks/useEventScopedData: a
  // synchronous setState inside an effect renders twice per load, and separate
  // loading/data flags can disagree with each other.
  const [settled, setSettled] = useState<{
    key:    string
    events: EventSummary[]
    error:  string | null
  } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Selection the user made in this tab. Null means "no explicit choice yet" and lets
  // the resolver fall through to URL → stored → default.
  //
  // Both of these are LAZY initializers rather than effects. `Date.now()` and
  // `localStorage` are impure, so they cannot be called during render; reading them
  // in an effect instead would resolve the first paint against a missing stored id
  // and bounce the organizer off their remembered event before settling.
  const [chosenEventId, setChosenEventId] = useState<string | null>(() => readStoredEventId())
  const [generation,    setGeneration]    = useState(0)
  const [mountedAt] = useState<number>(() => Date.now())

  // ── Load the summary list ──────────────────────────────────────────────────
  // The load is identified by (user, refreshKey). A result stamped with a different
  // key is ignored, so a refresh that lands out of order cannot install a stale list.
  const loadKey = `${user?.uid ?? 'anon'}:${refreshKey}`

  useEffect(() => {
    if (!user) return
    let cancelled = false

    void (async () => {
      try {
        const token = await getToken()
        if (cancelled) return
        if (!token) throw new Error('Unable to load your events.')

        const res = await fetch(`/api/organizer/events?limit=${EVENT_PAGE_SIZE}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (cancelled) return

        // 403 is a legitimate state, not a fault: a finance-only member holds no
        // `events` permission. An empty workspace, not an error banner.
        if (res.status === 403) { setSettled({ key: loadKey, events: [], error: null }); return }
        if (!res.ok) throw new Error('Unable to load your events.')

        const data = await res.json() as EventsListResponse
        if (cancelled) return

        setSettled({
          key: loadKey,
          error: null,
          events: data.events.map(e => ({
            draftId:            e.draftId,
            name:               e.name,
            slug:               e.slug,
            status:             e.status,
            lifecycleStatus:    e.lifecycleStatus,
            startDate:          e.startDate,
            endDate:            e.endDate,
            totalRegistrations: e.totalRegistrations,
            totalCapacity:      e.totalCapacity,
            updatedAt:          e.updatedAt,
            eventType:          e.eventType,
            eventSubtype:       e.eventSubtype,
          })),
        })
      } catch (e) {
        if (cancelled) return
        setSettled({
          key: loadKey, events: [],
          error: e instanceof Error ? e.message : 'Unable to load your events.',
        })
      }
    })()

    return () => { cancelled = true }
  }, [user, getToken, loadKey])

  const current = settled !== null && settled.key === loadKey
  // Memoised: the `[]` fallback would otherwise be a new array on every render, and
  // it is a dependency of the selection resolver and the context value below.
  const events  = useMemo(() => (current ? settled.events : []), [current, settled])
  const error   = current ? settled.error  : null
  const loading = Boolean(user) && !current

  // ── Resolve the selection ──────────────────────────────────────────────────
  // Recomputed from (url, stored, list) on every navigation, so Back/Forward move the
  // selection exactly as they move the page. There is no separate "current event"
  // state to drift out of sync — the URL is the record.
  const urlEventId = useMemo(() => {
    const fromPath = eventIdFromPathname(pathname)
    if (fromPath) return fromPath
    return searchParams.get(EVENT_PARAM)
  }, [pathname, searchParams])

  const selection = useMemo(() => {
    // Pure: every input is already resolved state. `chosenEventId` starts as the
    // remembered id (lazy initializer) and becomes the in-tab choice after a switch;
    // it never outranks the URL, because `selectEvent` writes the URL first.
    return resolveSelectedEvent({
      urlEventId,
      storedEventId: chosenEventId,
      events,
      now: mountedAt,
    })
  }, [urlEventId, chosenEventId, events, mountedAt])

  const selectedEventId = selection.eventId
  const isAllEvents     = selection.source === 'all'
  const selectedEvent   = useMemo(
    () => events.find(e => e.draftId === selectedEventId) ?? null,
    [events, selectedEventId],
  )

  // Remember only a VALIDATED selection — `selection.eventId` is always a member of the
  // authorized list, so a stale id can never be written back and resurrected. The
  // all-events CHOICE is remembered as the sentinel; `source: 'none'` (an empty workspace)
  // writes nothing, because "you own no events yet" is not a preference to restore.
  useEffect(() => {
    if (loading) return
    if (isAllEvents) writeStoredEventId(ALL_EVENTS_SELECTION)
    else if (selectedEventId) writeStoredEventId(selectedEventId)
  }, [loading, isAllEvents, selectedEventId])

  // ── Selecting ──────────────────────────────────────────────────────────────
  const selectEvent = useCallback((eventId: string) => {
    const toAll = isAllEventsSelection(eventId)
    // No-op guard, aware of BOTH shapes: re-picking the current event, or re-picking
    // All events while already on it.
    if (toAll ? isAllEvents : eventId === selectedEventId) return

    setChosenEventId(eventId)
    setGeneration(g => g + 1)
    writeStoredEventId(eventId)

    // Where the switch lands:
    //   • on the event workspace → swap the path segment, keep the tab
    //   • on an event-scoped route → stay put, swap ?eventId=
    //   • on a global route → stay put; global pages are not event-scoped
    const pathEventId = eventIdFromPathname(pathname)
    if (pathEventId) {
      // "All events" cannot be expressed while standing on ONE event's page — the path
      // itself names an event. Leaving the organizer there with a contradicting selector
      // would be the mixed-scope confusion the whole scope effort removed, so the switch
      // lands on the canonical all-events surface instead.
      if (toAll) { router.push(ALL_EVENTS_HREF); return }
      const tab = searchParams.get('tab')
      router.push(`/dashboard/events/${encodeURIComponent(eventId)}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`)
      return
    }
    // The Wallet (one event at a time, 2026-10-02) follows the selector through ?eventId= as well —
    // it is reached from Finance rather than its own nav row, and its "Increase Limit" round trip
    // returns with ?eventId=, which would otherwise outrank a later switch.
    if (isEventScopedPath(pathname, EVENT_SCOPED_PREFIXES) || pathname === '/dashboard/wallet') {
      const qs = searchParams.toString()
      // The sentinel travels in the URL like any selection, so Back/Forward move the
      // all-events choice exactly as they move an event choice.
      router.push(withEventParam(`${pathname}${qs ? `?${qs}` : ''}`, toAll ? ALL_EVENTS_SELECTION : eventId))
    }
  }, [selectedEventId, isAllEvents, pathname, searchParams, router])

  const refresh = useCallback(() => setRefreshKey(k => k + 1), [])

  const value = useMemo<EventContextValue>(() => ({
    events,
    selectedEventId,
    isAllEvents,
    selectedEvent,
    loading,
    error,
    urlEventMissing: selection.urlEventMissing,
    selectEvent,
    refresh,
    generation,
    now: mountedAt,
  }), [events, selectedEventId, isAllEvents, selectedEvent, loading, error, selection.urlEventMissing, selectEvent, refresh, generation, mountedAt])

  return <EventCtx.Provider value={value}>{children}</EventCtx.Provider>
}

/**
 * Reads the selected-event context.
 *
 * Throws outside the provider rather than returning a plausible empty value: a
 * component that silently believes no event is selected would render workspace-wide
 * data under an event heading, which is the exact class of bug this context exists
 * to make impossible.
 */
export function useEventContext(): EventContextValue {
  const ctx = useContext(EventCtx)
  if (!ctx) throw new Error('useEventContext must be used inside <EventContextProvider>')
  return ctx
}
