'use client'

// WhatsApp Inbox (Phase 1b) — the sidebar badge count.
//
// Fetches only while `enabled` (the Inbox row is actually visible: flag on + `broadcasts`),
// polls while the tab is visible, and refreshes at once when the Inbox marks a conversation
// read (INBOX_UNREAD_CHANGED_EVENT). Any failure — including the 403/404 the route gives a
// caller who may not see the Inbox — resolves to 0, never an error in the chrome.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { INBOX_UNREAD_CHANGED_EVENT, type UnreadCountResponse } from '@/lib/whatsapp-inbox/types'

const POLL_MS = 60_000

export function useInboxUnreadCount(enabled: boolean): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const load = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!token) return
        const res  = await fetch('/api/organizer/whatsapp-inbox/unread-count', { headers: { Authorization: `Bearer ${token}` } })
        const body = await res.json() as UnreadCountResponse
        if (!cancelled) setCount(res.ok && body.success ? (body.count ?? 0) : 0)
      } catch {
        if (!cancelled) setCount(0)
      }
    }

    void load()
    const timer = window.setInterval(load, POLL_MS)
    const onChange = () => { void load() }
    window.addEventListener(INBOX_UNREAD_CHANGED_EVENT, onChange)
    document.addEventListener('visibilitychange', onChange)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener(INBOX_UNREAD_CHANGED_EVENT, onChange)
      document.removeEventListener('visibilitychange', onChange)
    }
  }, [enabled])

  return enabled ? count : 0
}
