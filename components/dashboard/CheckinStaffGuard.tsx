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

export function CheckinStaffGuard() {
  const { user, getToken } = useAuth()
  const router = useRouter()
  // One check per mounted session — the role cannot change under the operator,
  // and re-running on every navigation would add a request to every page view.
  const checked = useRef(false)

  useEffect(() => {
    if (!user || checked.current) return
    checked.current = true

    let active = true
    void (async () => {
      try {
        const token = await getToken()
        if (!token || !active) return

        const res = await fetch('/api/organizer/workspace', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok || !active) return

        const info = await res.json() as WorkspaceInfoResponse
        if (!active || !info.checkinOnly) return

        // An assigned operator goes straight to their gate. With no assignment
        // ([] = every event) there is no single correct destination, so they are
        // sent to the events list, which their own console links from.
        const target = info.eventIds.length > 0
          ? `/ops/checkin/${encodeURIComponent(info.eventIds[0])}`
          : '/ops'
        router.replace(target)
      } catch {
        // Never block the dashboard on a routing hint.
      }
    })()

    return () => { active = false }
  }, [user, getToken, router])

  return null
}
