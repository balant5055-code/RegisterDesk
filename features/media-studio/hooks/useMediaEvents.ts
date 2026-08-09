'use client'

// RD-MEDIA-01 · Event source.
//
// Reads the EXISTING `GET /api/organizer/events`. Media Studio adds no event endpoint of
// its own — that route is already scoped to the caller's workspace server-side, so
// "only events you own" is enforced by code that already exists and is already tested.
//
// Only PUBLISHED events are offered: the event slug is the storage path segment
// (`events/{slug}/photos/...`), so an unpublished event has nowhere to put photos.

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import type { EventsListResponse } from '@/app/api/organizer/events/route'

export interface MediaEventRow {
  eventId:   string
  name:      string
  slug:      string
  startDate: string | null
  /** RD-MEDIA-02: drives the gallery-suggestion template. Media Studio passes these
   *  straight to the shared resolver and never interprets them itself. */
  eventType:    string | null
  eventSubtype: string | null
}

export interface MediaEventsState {
  events:  MediaEventRow[]
  loading: boolean
  error:   string | null
}

export function useMediaEvents(): MediaEventsState {
  const { user, getToken } = useAuth()
  const [events,  setEvents]  = useState<MediaEventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (user === undefined) return          // auth still resolving
    let cancelled = false

    const run = async () => {
      if (!user) { setLoading(false); return }
      try {
        const token = await getToken()
        if (cancelled || !token) return

        const res = await fetch('/api/organizer/events?limit=100', {
          headers: { Authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (cancelled) return
        if (!res.ok) throw new Error('Could not load your events. Please try again.')

        const data = await res.json() as EventsListResponse
        if (cancelled) return

        setEvents(
          data.events
            .filter(e => typeof e.slug === 'string' && e.slug !== '')
            .map(e => ({
              eventId:   e.draftId,
              name:      e.name,
              slug:      e.slug as string,
              startDate: e.startDate,
              eventType:    e.eventType,
              eventSubtype: e.eventSubtype,
            })),
        )
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your events.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => { cancelled = true }
  }, [user, getToken])

  return { events, loading, error }
}
