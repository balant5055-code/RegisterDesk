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

import { useCallback, useEffect, useRef, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type TeamPermission, type TeamRole } from '@/lib/team/types'
import type { WorkspaceInfoResponse }  from '@/app/api/organizer/workspace/route'
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

export interface WorkspacePerms {
  loading:     boolean
  isOwner:     boolean
  role:        string
  permissions: TeamPermission[]
  has:         (p: TeamPermission) => boolean
}

const INITIAL_PERMS: WorkspacePerms = {
  loading: true, isOwner: false, role: '', permissions: [], has: () => false,
}

export interface CommandData {
  perms:           WorkspacePerms
  loadEvents:      () => Promise<EventListItem[]>
  searchAttendees: (eventId: string, q: string) => Promise<AttendeeSearchResult[]>
}

export function useCommandData(enabled: boolean): CommandData {
  const [perms, setPerms] = useState<WorkspacePerms>(INITIAL_PERMS)
  const permsRequested = useRef(false)
  const eventsCache    = useRef<EventListItem[] | null>(null)
  const eventsInFlight = useRef<Promise<EventListItem[]> | null>(null)

  // ── Workspace role → permissions (once, on first activation) ─────────────────
  // Deferred until the palette is actually opened so a plain dashboard load never
  // pays for it; the ref guard keeps it to a single request thereafter.
  useEffect(() => {
    if (!enabled || permsRequested.current) return
    permsRequested.current = true
    let cancelled = false
    void (async () => {
      try {
        const headers = await authHeaders()
        if (!headers) { if (!cancelled) setPerms(p => ({ ...p, loading: false })); return }
        const res = await fetch('/api/organizer/workspace', { headers })
        if (!res.ok) { if (!cancelled) setPerms(p => ({ ...p, loading: false })); return }
        const data = await res.json() as WorkspaceInfoResponse
        const permissions = data.isOwner
          ? [...ALL_PERMISSIONS]
          : (ROLE_PERMISSIONS[data.role as TeamRole] ?? [])
        if (cancelled) return
        setPerms({
          loading:     false,
          isOwner:     data.isOwner,
          role:        data.role,
          permissions,
          has:         (p) => data.isOwner || permissions.includes(p),
        })
      } catch {
        if (!cancelled) setPerms(p => ({ ...p, loading: false }))
      }
    })()
    return () => { cancelled = true }
  }, [enabled])

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
