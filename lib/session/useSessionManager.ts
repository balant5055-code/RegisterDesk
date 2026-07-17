'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { signOut } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'

// ─── Constants ────────────────────────────────────────────────────────────────

// Code defaults — mirror security.sessionIdleTimeoutMinutes / sessionWarnBeforeMinutes.
// Callers pass live policy via `opts`; these are the fallback when none is supplied.
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000   // 60 minutes → hard logout
const DEFAULT_WARN_BEFORE_MS  =  5 * 60 * 1000   // warn 5 minutes before timeout

export interface SessionTimeoutOptions {
  idleTimeoutMs?: number
  warnBeforeMs?:  number
}

const ACTIVITY_EVENTS = [
  'mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'click',
] as const

const SESSION_BROADCAST_KEY = 'rd_session'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionManagerResult {
  showWarning:    boolean
  countdown:      number    // seconds remaining when warning is visible
  onStaySignedIn: () => Promise<void>
  onLogout:       () => void
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useSessionManager(enabled: boolean, opts?: SessionTimeoutOptions): SessionManagerResult {
  const [showWarning, setShowWarning] = useState(false)
  const [countdown,   setCountdown]   = useState(0)

  // Live policy (from security config) or the code defaults. Primitives → stable
  // deps; when the resolved config changes, the timers below restart with it.
  const idleTimeoutMs = opts?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const warnBeforeMs  = opts?.warnBeforeMs  ?? DEFAULT_WARN_BEFORE_MS
  const warnAtMs      = Math.max(0, idleTimeoutMs - warnBeforeMs)

  const idleTimerRef     = useRef<ReturnType<typeof setTimeout>  | undefined>(undefined)
  const warnTimerRef     = useRef<ReturnType<typeof setTimeout>  | undefined>(undefined)
  const countdownRef     = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const channelRef       = useRef<BroadcastChannel | undefined>(undefined)

  // ── Helpers ─────────────────────────────────────────────────────────────────

  const clearAll = useCallback(() => {
    clearTimeout(idleTimerRef.current)
    clearTimeout(warnTimerRef.current)
    clearInterval(countdownRef.current)
  }, [])

  const performLogout = useCallback(() => {
    // Clear the draft reference so a subsequent login starts fresh
    localStorage.removeItem('rd_event_draft_id')
    channelRef.current?.postMessage({ type: 'LOGOUT' })
    signOut(auth).catch(() => null)
    // Hard navigation: layout's onAuthStateChanged will also fire, but
    // window.location.replace here ensures immediate redirect even if the
    // layout's subscriber fires with a delay.
    window.location.replace('/login')
  }, [])

  // Start timers without touching React state — safe to call from effect body.
  const startTimers = useCallback(() => {
    clearAll()
    warnTimerRef.current = setTimeout(() => {
      setShowWarning(true)
      setCountdown(warnBeforeMs / 1000)
      countdownRef.current = setInterval(() => {
        setCountdown(c => Math.max(0, c - 1))
      }, 1000)
    }, warnAtMs)
    idleTimerRef.current = setTimeout(performLogout, idleTimeoutMs)
  }, [clearAll, performLogout, warnAtMs, warnBeforeMs, idleTimeoutMs])

  // Reset all timers — called from activity event handlers.
  const reset = useCallback(() => {
    setShowWarning(false)
    startTimers()
  }, [startTimers])

  // ── Public API ───────────────────────────────────────────────────────────────

  const onStaySignedIn = useCallback(async () => {
    // Force-refresh the Firebase ID token so the 1-hour token window also resets.
    await auth.currentUser?.getIdToken(true).catch(() => null)
    reset()
  }, [reset])

  const onLogout = useCallback(() => {
    clearAll()
    performLogout()
  }, [clearAll, performLogout])

  // ── Effect ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled) return

    // Multi-tab sync: when any tab logs out, all other tabs follow.
    const channel = new BroadcastChannel(SESSION_BROADCAST_KEY)
    channelRef.current = channel
    channel.onmessage = (e: MessageEvent<{ type: string }>) => {
      if (e.data?.type === 'LOGOUT') {
        clearAll()
        localStorage.removeItem('rd_event_draft_id')
        signOut(auth).catch(() => null)
        // Hard navigation in this tab so Back cannot re-expose the dashboard
        window.location.replace('/login')
      }
    }

    // Activity listeners call reset() (includes hiding the warning + restarting timers).
    const handleActivity = () => reset()
    ACTIVITY_EVENTS.forEach(evt =>
      window.addEventListener(evt, handleActivity, { passive: true }),
    )

    // On initial mount just start timers — no state to reset.
    startTimers()

    return () => {
      clearAll()
      ACTIVITY_EVENTS.forEach(evt =>
        window.removeEventListener(evt, handleActivity),
      )
      channel.close()
      channelRef.current = undefined
    }
  }, [enabled, reset, startTimers, clearAll])

  return { showWarning, countdown, onStaySignedIn, onLogout }
}
