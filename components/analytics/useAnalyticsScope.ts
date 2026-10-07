'use client'

// RD-ANALYTICS-08 · the one way an Analytics module gets its data.
//
// ═══ WHY THIS WAS EXTRACTED ══════════════════════════════════════════════════
// RD-ANALYTICS-06 put the fetch, the range state, the event-scope derivation and the
// loading/error machine inside the Overview component, which was right while there was one
// module. A second module copying that block would give the workspace two places where the
// window is chosen, two places where "All Events" is decided, and two chances for one of
// them to drift — which is the same class of duplication RD-ANALYTICS-04 removed from the
// insight engines.
//
// So the behaviour moves here verbatim and both modules consume it. Every rule it carried
// is preserved, and each is load-bearing:
//
//   • the SLUG, not the draft id, addresses the producer — the context's event row has it,
//     and an event without one has never been published;
//   • `scoped` is DERIVED, never stored. The React Compiler rejects setState in an effect
//     body, and it is right to: a stored copy can disagree with the selector for a render;
//   • a refresh keeps the previous data on screen rather than flashing a skeleton;
//   • ONE request feeds a whole module. The endpoint returns the complete
//     `AnalyticsResponse`, so a module reads the section it needs from what is already
//     there instead of issuing a second call.

import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { PRESET_DAYS, type AnalyticsRangePreset } from '@/lib/analytics/dateRange'
import type { AnalyticsResponse } from '@/lib/analytics/contract'

export type AnalyticsPreset = Exclude<AnalyticsRangePreset, 'custom'>
export const ANALYTICS_PRESETS = Object.keys(PRESET_DAYS) as AnalyticsPreset[]

type Load =
  | { state: 'loading' }
  | { state: 'ready';  data: AnalyticsResponse }
  | { state: 'error';  message: string }

export interface AnalyticsScopeState {
  /** The payload, or null while loading, on error, or when no single event is in scope. */
  data: AnalyticsResponse | null
  load: Load
  /** False ⇒ no single event is selected; the module must say so rather than aggregate. */
  scoped: boolean
  eventsLoading: boolean
  isAllEvents: boolean
  preset: AnalyticsPreset
  setPreset: (p: AnalyticsPreset) => void
  refreshing: boolean
  refresh: () => void
  /** The selected event's name from the context — a header fallback before data arrives. */
  selectedEventName: string | null
  /**
   * RD-ANALYTICS-12-33 · the URL named an event that is not in this workspace's authorized
   * list — it does not exist, is not published, or belongs to someone else. ONE flag for all
   * three on purpose: the list is the authorization boundary, and a module must say "not
   * available to you" rather than fall back to the "select an event" placeholder that means
   * nothing was asked for.
   */
  urlEventMissing: boolean
  /** "last 30 days" — from the SERVED range, never the pressed button. Null before data. */
  windowDays: number | null
  windowLabel: string
  /** "the 30 days before" — the phrase a delta is measured against. */
  baselineLabel: string
}

/**
 * RD-ANALYTICS-12-33 · one payload per page, shared.
 *
 * A module page renders the module strip AND the module body, and the strip now hides the
 * modules the payload's `capabilities.modules` says this event cannot support. Reading the
 * payload in two components must not mean fetching it twice, so a page wraps both in
 * `AnalyticsScopeProvider` and every consumer reads the ONE state through this context.
 * Without a provider the hook behaves exactly as before — a standalone fetch — so no caller
 * is forced onto the provider to keep working.
 *
 * This is request-local React state, not a cache: it lives as long as the page.
 */
export const AnalyticsScopeContext = createContext<AnalyticsScopeState | null>(null)

export function useAnalyticsScope(initialPreset: AnalyticsPreset = '30d'): AnalyticsScopeState {
  const shared = useContext(AnalyticsScopeContext)
  // Hooks cannot be conditional: the standalone state is always constructed, and simply
  // does not fetch when a provider is present.
  const standalone = useStandaloneAnalyticsScope(initialPreset, shared === null)
  return shared ?? standalone
}

export function useStandaloneAnalyticsScope(initialPreset: AnalyticsPreset = '30d', enabled = true): AnalyticsScopeState {
  const { getToken } = useAuth()
  const { selectedEventId, selectedEvent, isAllEvents, loading: eventsLoading, urlEventMissing } = useEventContext()
  const [preset, setPreset] = useState<AnalyticsPreset>(initialPreset)
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  const [nonce, setNonce] = useState(0)

  const slug = selectedEvent?.slug ?? null
  const scoped = !eventsLoading && !isAllEvents && Boolean(selectedEventId) && Boolean(slug)

  useEffect(() => {
    if (!enabled || !scoped || !slug) return

    let alive = true
    void (async () => {
      setLoad(prev => (prev.state === 'ready' ? prev : { state: 'loading' }))
      try {
        const token = await getToken()
        const res = await fetch(
          `/api/organizer/analytics/overview/${encodeURIComponent(slug)}?preset=${preset}`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' },
        )
        const body = await res.json().catch(() => ({})) as
          { success?: boolean; analytics?: AnalyticsResponse; error?: string }
        if (!alive) return
        if (!res.ok || !body.success || !body.analytics) {
          setLoad({ state: 'error', message: body.error ?? `Could not load analytics (${res.status}).` })
          return
        }
        setLoad({ state: 'ready', data: body.analytics })
      } catch (e) {
        if (alive) setLoad({ state: 'error', message: e instanceof Error ? e.message : 'Could not load analytics.' })
      } finally {
        if (alive) setRefreshing(false)
      }
    })()
    return () => { alive = false }
  }, [getToken, slug, scoped, preset, nonce, enabled])

  const refresh = useCallback(() => { setRefreshing(true); setNonce(n => n + 1) }, [])

  const data = scoped && load.state === 'ready' ? load.data : null

  /**
   * Every window phrase names the window the SERVER reported, never the pressed button.
   * The two can differ — an unrecognised preset falls back server-side — and a page that
   * narrated the request while showing the fallback's figures would be wrong in exactly the
   * way this architecture exists to prevent.
   */
  const servedPreset = data?.scope.range.preset
  const windowDays   = servedPreset && servedPreset !== 'custom' ? PRESET_DAYS[servedPreset] : null
  const windowLabel   = windowDays === null ? 'selected period' : `last ${windowDays} days`
  const baselineLabel = windowDays === null ? 'the preceding period' : `the ${windowDays} days before`

  return {
    data, load, scoped, eventsLoading, isAllEvents,
    preset, setPreset, refreshing, refresh,
    selectedEventName: selectedEvent?.name ?? null,
    urlEventMissing,
    windowDays, windowLabel, baselineLabel,
  }
}
