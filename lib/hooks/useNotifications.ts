'use client'

// Organizer Notification Center — client data hook + API helpers (Phase H.4.3).
//
// The API feed is the single, permission-correct source (it resolves the
// workspace and gates categories server-side). For the workspace OWNER we also
// attach a lightweight Firestore onSnapshot listener to their own inbox path as
// a real-time CHANGE TRIGGER — when a new notification lands, we refetch the
// authoritative feed. Team members (whose own path is empty) fall back to a
// focus-driven refresh. No interval polling anywhere.

import { useCallback, useEffect, useRef, useState } from 'react'
import { collection, query, orderBy, limit, onSnapshot } from 'firebase/firestore'
import { db }   from '@/lib/firebase/firestore'
import { auth } from '@/lib/firebase/auth'
import type { NotificationView, NotificationFeedResponse } from '@/lib/notifications/inbox/types'

async function authHeaders(): Promise<Record<string, string> | null> {
  const user = auth.currentUser
  if (!user) return null
  return { Authorization: `Bearer ${await user.getIdToken()}` }
}

export interface NotificationQuery {
  cursor?:   string | null
  category?: string | null
  eventId?:  string | null
  q?:        string | null
  unread?:   boolean
  limit?:    number
}

const EMPTY_FEED: NotificationFeedResponse = { notifications: [], nextCursor: null, unreadCount: 0 }

export async function fetchNotifications(params: NotificationQuery = {}): Promise<NotificationFeedResponse> {
  const headers = await authHeaders()
  if (!headers) return EMPTY_FEED
  const sp = new URLSearchParams()
  if (params.cursor)   sp.set('cursor', params.cursor)
  if (params.category) sp.set('category', params.category)
  if (params.eventId)  sp.set('eventId', params.eventId)
  if (params.q)        sp.set('q', params.q)
  if (params.unread)   sp.set('unread', 'true')
  if (params.limit)    sp.set('limit', String(params.limit))
  const res = await fetch(`/api/organizer/notifications?${sp.toString()}`, { headers })
  if (!res.ok) return EMPTY_FEED
  return await res.json() as NotificationFeedResponse
}

export async function markNotificationRead(id: string): Promise<void> {
  const headers = await authHeaders()
  if (!headers) return
  await fetch(`/api/organizer/notifications/${id}/read`, { method: 'POST', headers })
}

export async function markAllNotificationsRead(): Promise<void> {
  const headers = await authHeaders()
  if (!headers) return
  await fetch('/api/organizer/notifications/read-all', { method: 'POST', headers })
}

// ─── Bell hook (recent + unread badge, live for the owner) ────────────────────

const BELL_LIMIT = 20

export interface UseNotifications {
  recent:      NotificationView[]
  unreadCount: number
  loading:     boolean
  markRead:    (id: string) => Promise<void>
  markAllRead: () => Promise<void>
  refresh:     () => void
}

export function useNotifications(): UseNotifications {
  const [recent, setRecent]           = useState<NotificationView[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading]         = useState(true)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const feed = await fetchNotifications({ limit: BELL_LIMIT })
    if (!mounted.current) return
    setRecent(feed.notifications)
    setUnreadCount(feed.unreadCount)
    setLoading(false)
  }, [])

  // Initial load + refresh when the tab regains focus.
  useEffect(() => {
    mounted.current = true
    void refresh()
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { mounted.current = false; window.removeEventListener('focus', onFocus) }
  }, [refresh])

  // Owner real-time: a change to the newest inbox docs triggers a refetch.
  // (For team members the own-path listener is empty and only fires once.)
  useEffect(() => {
    const user = auth.currentUser
    if (!user) return
    const qy = query(collection(db, 'users', user.uid, 'notifications'), orderBy('createdAt', 'desc'), limit(5))
    let first = true
    const unsub = onSnapshot(
      qy,
      () => { if (first) { first = false; return } void refresh() },
      () => { /* offline / rules — API path still works, ignore */ },
    )
    return unsub
  }, [refresh])

  const markRead = useCallback(async (id: string) => {
    setRecent(prev => prev.map(n => (n.id === id ? { ...n, read: true } : n)))
    setUnreadCount(c => Math.max(0, c - 1))
    await markNotificationRead(id)
    void refresh()
  }, [refresh])

  const markAllRead = useCallback(async () => {
    setRecent(prev => prev.map(n => ({ ...n, read: true })))
    setUnreadCount(0)
    await markAllNotificationsRead()
    void refresh()
  }, [refresh])

  return { recent, unreadCount, loading, markRead, markAllRead, refresh: () => { void refresh() } }
}
