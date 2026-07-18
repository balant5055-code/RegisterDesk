'use client'

// Offline check-in orchestration hook.
//
//   online  → caller uses the live /api/checkin/scan API directly.
//   offline → caller calls scanOffline(): validate against IndexedDB, queue the
//             action, return a result the existing ResultCard can render.
//   reconnect → queued actions replay against the (idempotent) scan API. If the
//             server reports the attendee was already checked in elsewhere, the
//             server wins and the queue item is marked as a resolved conflict.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  setCurrentEvent, replaceAttendees, getAttendee, markLocalCheckedIn,
  countAttendees, enqueue, getQueueByStatus, updateQueueItem, isQueued, countByStatus,
} from '@/lib/checkin/offlineDb'
import type { CacheResponse } from '@/app/api/checkin/cache/route'
import type { CheckInResult } from '@/app/api/checkin/scan/route'

interface Params { eventSlug: string; token: string; onSynced?: () => void }

export interface OfflineCheckin {
  online:        boolean
  cachedCount:   number
  pendingCount:  number
  conflictCount: number
  truncated:     boolean
  syncing:       boolean
  cacheError:    string | null
  refreshCache:  () => void
  scanOffline:   (ticketCode: string) => Promise<CheckInResult>
  syncNow:       () => void
}

export function useOfflineCheckin({ eventSlug, token, onSynced }: Params): OfflineCheckin {
  const [online,        setOnline]        = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true))
  const [cachedCount,   setCachedCount]   = useState(0)
  const [pendingCount,  setPendingCount]  = useState(0)
  const [conflictCount, setConflictCount] = useState(0)
  const [truncated,     setTruncated]     = useState(false)
  const [syncing,       setSyncing]       = useState(false)
  const [cacheError,    setCacheError]    = useState<string | null>(null)
  const syncingRef = useRef(false)

  const refreshCounts = useCallback(() => {
    Promise.all([countAttendees(), countByStatus('pending'), countByStatus('conflict')])
      .then(([attendees, pending, conflict]) => {
        setCachedCount(attendees)
        setPendingCount(pending)
        setConflictCount(conflict)
      }).catch(() => { /* counts are best-effort */ })
  }, [])

  const refreshCache = useCallback(() => {
    if (!token) return
    setCacheError(null)
    // setCurrentEvent wipes any other event's cache before we store this one.
    setCurrentEvent(eventSlug)
      .then(() => fetch(`/api/checkin/cache?slug=${encodeURIComponent(eventSlug)}`, {
        headers: { authorization: `Bearer ${token}` }, cache: 'no-store',
      }))
      .then(res => { if (!res.ok) throw new Error('CACHE_FETCH_FAILED'); return res.json() as Promise<CacheResponse> })
      .then(data => { setTruncated(data.truncated); return replaceAttendees(eventSlug, data.attendees) })
      .then(() => refreshCounts())
      .catch(() => setCacheError('Could not refresh the offline attendee list.'))
  }, [eventSlug, token, refreshCounts])

  const scanOffline = useCallback(async (ticketCode: string): Promise<CheckInResult> => {
    const code = ticketCode.trim().toUpperCase()
    const att  = await getAttendee(code)
    if (!att) return { success: false, error: 'TICKET_NOT_FOUND' }
    if (att.status === 'cancelled')        return { success: false, error: 'REGISTRATION_CANCELLED' }
    if (att.status === 'pending')          return { success: false, error: 'REGISTRATION_PENDING' }
    if (att.paymentStatus === 'refunded')  return { success: false, error: 'REGISTRATION_REFUNDED' }

    const attendee = { name: att.attendeeName, passName: att.passName }
    if (att.checkedIn || await isQueued(code)) {
      return { success: true, alreadyCheckedIn: true, attendee, checkedInAt: att.checkedInAt ?? undefined }
    }

    const at = new Date().toISOString()
    await markLocalCheckedIn(code, at)
    await enqueue({
      ticketCode: code, registrationId: att.registrationId, attendeeName: att.attendeeName,
      eventSlug, scannedAt: at, source: 'offline', status: 'pending',
    })
    refreshCounts()
    return { success: true, alreadyCheckedIn: false, attendee, checkedInAt: at }
  }, [eventSlug, refreshCounts])

  const syncNow = useCallback(() => {
    if (syncingRef.current || !token) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    syncingRef.current = true
    setSyncing(true)

    ;(async () => {
      const queue = await getQueueByStatus('pending')
      for (const item of queue) {
        if (item.id == null) continue
        let res: Response
        try {
          res = await fetch('/api/checkin/scan', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ ticketCode: item.ticketCode, source: 'offline-sync', eventSlug: item.eventSlug }),
          })
        } catch {
          break  // network dropped mid-sync — leave the rest pending for next time
        }
        if (res.status === 429) break          // rate limited — retry later
        if (res.status === 401) { await updateQueueItem(item.id, { status: 'failed', message: 'Session expired' }); break }

        const json = await res.json().catch(() => null) as CheckInResult | null
        if (res.ok && json?.success) {
          // Server wins: a true alreadyCheckedIn here means it was recorded
          // elsewhere before our queued action replayed.
          if (json.alreadyCheckedIn) await updateQueueItem(item.id, { status: 'conflict', message: 'Already checked in on the server' })
          else                       await updateQueueItem(item.id, { status: 'synced' })
        } else {
          // Server rejected (cancelled/refunded/not found) — server wins, resolve.
          await updateQueueItem(item.id, { status: 'conflict', message: json?.error ?? 'Rejected by server' })
        }
      }
    })()
      .catch(() => { /* swallow — counts reflect what synced */ })
      .finally(() => {
        syncingRef.current = false
        setSyncing(false)
        refreshCounts()
        onSynced?.()
      })
  }, [token, refreshCounts, onSynced])

  // Init: select the event (wiping any stale event cache), prime counts, and
  // download the list if online. Deferred so no setState runs in the effect body.
  useEffect(() => {
    const t = setTimeout(() => {
      setCurrentEvent(eventSlug).then(() => {
        refreshCounts()
        if (typeof navigator === 'undefined' || navigator.onLine) refreshCache()
      }).catch(() => { /* ignore */ })
    }, 0)
    return () => clearTimeout(t)
  }, [eventSlug, refreshCache, refreshCounts])

  // Connectivity transitions.
  useEffect(() => {
    const goOnline  = () => { setOnline(true); syncNow() }
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [syncNow])

  return { online, cachedCount, pendingCount, conflictCount, truncated, syncing, cacheError, refreshCache, scanOffline, syncNow }
}
