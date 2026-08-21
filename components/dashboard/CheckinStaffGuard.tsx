'use client'

// RD-CHECKIN-STAFF-01 — sends a gate-only operator to their own console.
//
// ═══ THIS IS ROUTING, NOT SECURITY ═══════════════════════════════════════════
// It must not be read as the control that keeps `checkin_staff` out of the
// organizer dashboard. That control is server-side and already in place:
//   • authorizeAnyWorkspace refuses gate-only roles (the dashboard aggregate)
//   • every organizer route requires a permission the role does not hold
//   • authorizeEvent additionally confines gate routes to assigned events
//
// So a gate operator who reaches /dashboard sees a shell whose data calls all
// fail. This component exists so they see their gate instead of a wall of errors.
// Disabling it in a browser reveals nothing, because nothing here is a gate.
//
// Rendered inside the dashboard layout, and it renders nothing itself.

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/auth/AuthProvider'
import type { WorkspaceInfoResponse } from '@/app/api/organizer/workspace/route'

/**
 * Attempt schedule for the workspace lookup.
 *
 * A gate operator's very first paint races Firebase's token refresh, and race-morning
 * networks are the worst ones this product runs on. One attempt with every failure
 * swallowed left the operator parked on a dashboard that shows them nothing — the exact
 * symptom reported from the gate. Three bounded attempts, then stop: this is a routing
 * hint, so it may cost a moment but must never spin.
 */
const RETRY_DELAYS_MS = [0, 400, 1200] as const

export function CheckinStaffGuard() {
  const { user, getToken } = useAuth()
  const router = useRouter()

  /**
   * Latched ONLY once the workspace answered definitively — not merely because an
   * attempt was made. That distinction is the fix: the previous version set this before
   * awaiting anything, so a single expired token or dropped request permanently disabled
   * the guard for the whole session with no way back.
   */
  const resolved = useRef(false)

  useEffect(() => {
    if (!user || resolved.current) return

    let active = true
    void (async () => {
      for (const delay of RETRY_DELAYS_MS) {
        if (!active) return
        if (delay > 0) await new Promise(r => setTimeout(r, delay))
        if (!active) return

        let info: WorkspaceInfoResponse
        try {
          const token = await getToken()
          if (!token) continue                                  // not minted yet — retry
          const res = await fetch('/api/organizer/workspace', {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
          })
          // 401 = the token went stale between mint and arrival; 5xx = the server had a
          // moment. Both are worth another attempt.
          if (res.status === 401 || res.status >= 500) continue
          if (!res.ok) { resolved.current = true; return }      // a real refusal — respect it
          info = await res.json() as WorkspaceInfoResponse
        } catch {
          continue                                              // transport — retry
        }

        if (!active) return
        resolved.current = true
        if (!info.checkinOnly) return

        // ═══ WHY NOT eventIds[0] ═════════════════════════════════════════════
        // It used to take the first id whenever the list was non-empty. `eventIds` has no
        // meaningful order — it is the order events were assigned — so an operator with
        // two assignments was dropped onto whichever came first, which on the live account
        // was a two-registration test event while the real race sat at index 1. Picking any
        // element of a multi-element list is a guess, and a wrong guess at a start line
        // reads as "check-in is broken".
        //
        // So: one assignment is unambiguous and goes straight through. Anything else — two
        // events, or none ([] meaning unrestricted) — has no single right answer, and the
        // operator chooses on /ops.
        const target = info.eventIds.length === 1
          ? `/ops/checkin/${encodeURIComponent(info.eventIds[0])}`
          : '/ops'
        router.replace(target)
        return
      }
      // Attempts exhausted. Deliberately NOT latched: the next mount tries again rather
      // than stranding the operator for the session.
    })()

    return () => { active = false }
  }, [user, getToken, router])

  return null
}
