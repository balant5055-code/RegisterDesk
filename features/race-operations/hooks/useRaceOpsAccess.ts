'use client'

// RD-RACEOPS-01 · Race Operations — client access resolution.
//
// Reads the caller's effective workspace role from the EXISTING endpoint
// GET /api/organizer/workspace (app/api/organizer/workspace/route.ts) — Race
// Operations adds no API route and no new permission source. The fetch/auth shape
// is copied from the existing consumer of that same endpoint,
// components/dashboard/WorkspaceBanner.tsx, so there is one pattern, not two.
//
// UI gating only. The server remains authoritative (see utils/access.ts).

import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth/AuthProvider'
import type { WorkspaceInfoResponse } from '@/app/api/organizer/workspace/route'
import type { RaceOpsAccess } from '@/features/race-operations/types'
import { canAccessRaceOperations } from '@/features/race-operations/utils/access'

const RESOLVING: RaceOpsAccess = { allowed: undefined, role: null, isOwner: false }

export function useRaceOpsAccess(): RaceOpsAccess {
  const { user, getToken } = useAuth()
  const [access, setAccess] = useState<RaceOpsAccess>(RESOLVING)

  useEffect(() => {
    if (user === undefined) return          // auth still resolving — never decide yet
    let cancelled = false

    const run = async () => {
      if (!user) {
        // The (dashboard) layout already redirects signed-out users; stay in the
        // resolving state so this hook never flashes a denial mid-redirect.
        return
      }
      try {
        const token = await getToken()
        if (cancelled || !token) return
        const res = await fetch('/api/organizer/workspace', {
          headers: { Authorization: `Bearer ${token}` },
          cache:   'no-store',
        })
        if (cancelled) return
        if (!res.ok) {
          setAccess({ allowed: false, role: null, isOwner: false })
          return
        }
        const info = await res.json() as WorkspaceInfoResponse
        if (cancelled) return
        setAccess({
          allowed: canAccessRaceOperations(info),
          role:    info.role,
          isOwner: info.isOwner,
        })
      } catch {
        if (!cancelled) setAccess({ allowed: false, role: null, isOwner: false })
      }
    }

    void run()
    return () => { cancelled = true }
  }, [user, getToken])

  return access
}
