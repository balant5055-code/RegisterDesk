'use client'

// RD-ORG-FOUNDATION · Event-scoped fetching with stale-response protection.
//
// ═══ THE BUG THIS EXISTS TO PREVENT ══════════════════════════════════════════
// Organizer opens Registrations for Event A. Request A starts. They switch to
// Event B before it lands. Request B starts and finishes first. Request A finishes
// LAST and overwrites the UI — so the page header, the breadcrumb and the event
// selector all say "Event B" while the table shows Event A's attendees.
//
// Nothing about that is visible as an error. It is simply wrong data, presented
// with total confidence, on a screen an organizer uses to admit people to a venue.
//
// Two independent guards, because either alone leaves a hole:
//
//   1. AbortController — cancels the in-flight request on switch. Saves the work,
//      but cannot help when the response is already decoding.
//   2. Generation check — every result carries the generation it was requested
//      under, and is DISCARDED unless that still matches. This is the one that
//      actually closes the race; the abort is an optimisation on top.
//
// The generation comes from EventContext and bumps on every selection change, so a
// module never has to reason about switching at all.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { useEventContext } from '@/components/dashboard/EventContextProvider'

export interface EventScopedState<T> {
  data:      T | null
  loading:   boolean
  error:     string | null
  /** True when there is no selected event, so no request was made. */
  noEvent:   boolean
  /** Re-run the fetch for the current event. */
  reload:    () => void
}

export interface EventScopedOptions<T> {
  /**
   * Builds the request for an event. Receives the AbortSignal so the fetch is
   * cancelled on switch/unmount.
   *
   * Must THROW on failure — a resolved promise is treated as success.
   */
  fetcher: (eventId: string, token: string, signal: AbortSignal) => Promise<T>
  /** Message shown when `fetcher` throws without one. */
  errorMessage?: string
  /** Skip fetching (e.g. a gated feature is off). */
  enabled?: boolean
}

/**
 * Fetches data for the selected event, guaranteeing the result on screen belongs to
 * the event currently on screen.
 *
 * Modules supply only the request; every concern about switching, cancellation,
 * ordering and token freshness is handled here so it is solved once rather than
 * re-derived (and re-broken) in each module phase.
 */
export function useEventScopedData<T>(opts: EventScopedOptions<T>): EventScopedState<T> {
  const { fetcher, errorMessage = 'Unable to load this data.', enabled = true } = opts
  const { selectedEventId, generation } = useEventContext()
  const { getToken } = useAuth()

  // ═══ ONE settled result, not three independent flags ═══════════════════════
  // `loading` is DERIVED, never assigned: it is simply "the settled result does not
  // belong to what is on screen". Three consequences, all wanted:
  //
  //   • no synchronous setState inside the effect (React 19 flags that as a
  //     cascading render, and rightly — it renders twice for every fetch)
  //   • loading can never disagree with the data beside it
  //   • the stale-response guard stops being a separate mechanism: a result stamped
  //     with the wrong event or generation simply is not this render's result
  const [settled, setSettled] = useState<{
    eventId:    string
    generation: number
    data:       T | null
    error:      string | null
  } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  // Latest fetcher without making it a dependency: modules almost always pass an
  // inline closure, and depending on it would refetch on every parent render.
  const fetcherRef = useRef(fetcher)
  useEffect(() => { fetcherRef.current = fetcher }, [fetcher])

  useEffect(() => {
    if (!enabled || !selectedEventId) return

    const controller = new AbortController()
    // Captured at request time. The result is only ACCEPTED if both still match —
    // covering an event switch and a switch-and-switch-back, which a plain
    // "is it still the same event?" check would wrongly accept.
    const reqGeneration = generation
    const reqEventId    = selectedEventId
    let cancelled = false

    void (async () => {
      try {
        const token = await getToken()
        if (cancelled || controller.signal.aborted) return
        if (!token) throw new Error('Your session has expired. Please sign in again.')

        const result = await fetcherRef.current(reqEventId, token, controller.signal)
        if (cancelled || controller.signal.aborted) return

        // Stamped with what it was fetched FOR. A late response from a previous
        // event still lands here, but renders as nothing because the stamp will not
        // match the current event — it can never paint over the current one.
        setSettled({ eventId: reqEventId, generation: reqGeneration, data: result, error: null })
      } catch (e) {
        if (cancelled || controller.signal.aborted) return
        if (e instanceof DOMException && e.name === 'AbortError') return
        setSettled({
          eventId: reqEventId, generation: reqGeneration, data: null,
          error: e instanceof Error ? e.message : errorMessage,
        })
      }
    })()

    return () => { cancelled = true; controller.abort() }
  }, [selectedEventId, generation, enabled, reloadKey, getToken, errorMessage])

  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  // Does the settled result describe what is on screen right now?
  const current = settled !== null
    && settled.eventId === selectedEventId
    && settled.generation === generation

  return {
    // A stale result renders as nothing rather than as the previous event's rows —
    // leaving those on screen under a new event's heading is the same lie the
    // generation stamp exists to prevent.
    data:    current ? settled.data  : null,
    error:   current ? settled.error : null,
    loading: Boolean(selectedEventId) && enabled && !current,
    noEvent: !selectedEventId,
    reload,
  }
}
