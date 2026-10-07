'use client'

// Lazy data source for the Global Command Palette (Phase H.4.2).
//
// Reuses EXISTING organizer APIs only:
//   • GET /api/organizer/workspace                      → role → permissions (advisory gating)
//   • GET /api/organizer/events                         → event search (client-side fuzzy)
//   • GET /api/organizer/events/[id]/checkin/search?q=  → per-event attendee search
//
// Nothing is fetched until the palette needs it: the workspace role loads once
// on mount (cheap, cached, no-store), events load on the first query and are
// cached, attendee search is called on demand and scoped to the current event.

import { useCallback, useRef } from 'react'
import { auth } from '@/lib/firebase/auth'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import type { EventListItem, EventsListResponse } from '@/app/api/organizer/events/route'
import type { AttendeeSearchResult, AttendeeSearchResponse } from '@/app/api/organizer/events/[eventId]/checkin/search/route'

const EVENT_PAGE_LIMIT = 100
const MAX_EVENT_PAGES   = 4    // cap client-side event cache at 400 for fuzzy search

async function authHeaders(): Promise<Record<string, string> | null> {
  const user = auth.currentUser
  if (!user) return null
  const token = await user.getIdToken()
  return { Authorization: `Bearer ${token}` }
}

// RD-ORG-FOUNDATION — the permission projection moved to
// lib/hooks/useWorkspacePermissions so the organizer sidebar and this palette gate
// on ONE implementation over the server's ROLE_PERMISSIONS matrix. Previously only
// the palette was permission-aware; the sidebar showed every row to every role.
// Re-exported so existing `WorkspacePerms` importers are unaffected.
import type { WorkspacePerms } from '@/lib/hooks/useWorkspacePermissions'
export type { WorkspacePerms }

export interface CommandData {
  perms:           WorkspacePerms
  loadEvents:      () => Promise<EventListItem[]>
  searchAttendees: (eventId: string, q: string) => Promise<AttendeeSearchResult[]>
}

export function useCommandData(enabled: boolean): CommandData {
  // Shared with the organizer sidebar — one implementation, one source (the server's
  // ROLE_PERMISSIONS matrix). Still deferred behind `enabled`, so a plain dashboard
  // load does not pay for a palette that was never opened.
  const perms = useWorkspacePermissions(enabled)

  const eventsCache    = useRef<EventListItem[] | null>(null)
  const eventsInFlight = useRef<Promise<EventListItem[]> | null>(null)

  // ── Events (lazy, cached, paginated up to the cap) ──────────────────────────
  const loadEvents = useCallback(async (): Promise<EventListItem[]> => {
    if (eventsCache.current)   return eventsCache.current
    if (eventsInFlight.current) return eventsInFlight.current

    eventsInFlight.current = (async () => {
      const headers = await authHeaders()
      if (!headers) return []
      const all: EventListItem[] = []
      let cursor: string | null = null
      for (let page = 0; page < MAX_EVENT_PAGES; page++) {
        const qs  = `limit=${EVENT_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const res = await fetch(`/api/organizer/events?${qs}`, { headers })
        if (!res.ok) break
        const data = await res.json() as EventsListResponse
        all.push(...data.events)
        if (!data.nextCursor) break
        cursor = data.nextCursor
      }
      eventsCache.current = all
      return all
    })()

    try { return await eventsInFlight.current }
    finally { eventsInFlight.current = null }
  }, [])

  // ── Attendee search (per-event, reuses the check-in search endpoint) ────────
  const searchAttendees = useCallback(async (eventId: string, q: string): Promise<AttendeeSearchResult[]> => {
    if (q.trim().length < 2) return []
    const headers = await authHeaders()
    if (!headers) return []
    const res = await fetch(
      `/api/organizer/events/${eventId}/checkin/search?q=${encodeURIComponent(q.trim())}`,
      { headers },
    )
    if (!res.ok) return []   // e.g. draft event (403) or not accepting check-ins — quietly no results
    const data = await res.json() as AttendeeSearchResponse
    return data.results
  }, [])

  return { perms, loadEvents, searchAttendees }
}
