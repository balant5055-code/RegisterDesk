'use client'

// RD-RACEOPS-01 · Race Operations — organizer event + race (pass) source.
//
// Reads the EXISTING endpoint GET /api/organizer/events. Race Operations adds no
// API route, no query, and no Firestore read of its own.
//
// Why that endpoint is exactly right:
//   • It is already scoped to the caller's own workspace — it queries
//     `users/{workspaceUid}/eventDrafts` after `authorizeWorkspace(req,'events')`,
//     so "only events owned by the logged-in organizer" is enforced SERVER-SIDE by
//     code that already exists. This module never filters by owner on the client.
//   • It already returns `passes: EventPassSummary[]` per event, which IS the race /
//     distance list (Phase 0 · D2 — a distance is a pass). So the race selector needs
//     no second request.
//   • It is already cursor-paginated (`nextCursor`), so large accounts are safe.
//
// Projection into the module's own selection types keeps `EventListItem` from
// leaking through the module and out into its components.

import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import type { EventsListResponse, EventListItem } from '@/app/api/organizer/events/route'
import type { RaceOpsEventSelection, RaceOpsRaceSelection } from '@/features/race-operations/types'

const PAGE_SIZE = 50

export interface RaceOpsEventRow extends RaceOpsEventSelection {
  races: RaceOpsRaceSelection[]
}

export interface RaceOpsEventsState {
  events:      RaceOpsEventRow[]
  loading:     boolean
  loadingMore: boolean
  error:       string | null
  hasMore:     boolean
  loadMore:    () => void
}

function projectEvent(e: EventListItem): RaceOpsEventRow {
  const races: RaceOpsRaceSelection[] = e.passes.map(p => ({
    passId:        p.id,
    name:          p.name,
    registrations: p.sold,
  }))
  return {
    eventId:         e.draftId,
    name:            e.name,
    slug:            e.slug,
    eventType:       e.eventType,
    lifecycleStatus: e.lifecycleStatus,
    startDate:       e.startDate,
    raceCount:       races.length,
    races,
  }
}

export function useRaceOpsEvents(): RaceOpsEventsState {
  const { user, getToken } = useAuth()

  const [events,      setEvents]      = useState<RaceOpsEventRow[]>([])
  const [loading,     setLoading]     = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [cursor,      setCursor]      = useState<string | null>(null)
  const [hasMore,     setHasMore]     = useState(false)
  // Bumped by loadMore() to request the next page; the effect owns every fetch so
  // there is exactly ONE request path (no duplicated fetch logic).
  const [pageRequest, setPageRequest] = useState(0)

  useEffect(() => {
    if (user === undefined) return          // auth still resolving
    let cancelled = false

    const run = async () => {
      if (!user) { setLoading(false); return }
      const isFirstPage = pageRequest === 0
      if (isFirstPage) setLoading(true)
      else             setLoadingMore(true)

      try {
        const token = await getToken()
        if (cancelled) return
        if (!token) throw new Error('Your session has expired. Please sign in again.')

        const qs = new URLSearchParams({ limit: String(PAGE_SIZE) })
        if (!isFirstPage && cursor) qs.set('cursor', cursor)

        const res = await fetch(`/api/organizer/events?${qs.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (cancelled) return
        if (!res.ok) throw new Error('Could not load your events. Please try again.')

        const data = await res.json() as EventsListResponse
        if (cancelled) return

        const page = data.events.map(projectEvent)
        setEvents(prev => (isFirstPage ? page : [...prev, ...page]))
        setCursor(data.nextCursor)
        setHasMore(data.nextCursor !== null)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your events.')
      } finally {
        if (!cancelled) { setLoading(false); setLoadingMore(false) }
      }
    }

    void run()
    return () => { cancelled = true }
  // `cursor` is intentionally NOT a dependency: it is read as the "resume point" for
  // the page that `pageRequest` asks for. Including it would refetch on every
  // successful page (cursor changes on each response) and loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, getToken, pageRequest])

  const loadMore = useCallback(() => {
    setPageRequest(n => n + 1)
  }, [])

  return { events, loading, loadingMore, error, hasMore, loadMore }
}
