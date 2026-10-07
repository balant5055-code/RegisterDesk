'use client'

// RD-ORG-FOUNDATION · The caller's effective permissions, for ADVISORY UI gating.
//
// ═══ THIS GRANTS NOTHING ═════════════════════════════════════════════════════
// It exists so the organizer is not shown doors that will slam. Every organizer
// route re-authorizes server-side through authorizeWorkspace, so a client that
// ignores this hook — or edits it in a debugger — gains exactly nothing. The server
// is the security boundary; this is courtesy.
//
// ═══ WHY IT IS NOT A SECOND MATRIX ═══════════════════════════════════════════
// It imports ROLE_PERMISSIONS / ALL_PERMISSIONS from lib/team/types — the SAME
// array the server authorizes against. This is a projection of the server's matrix,
// not a copy of it: adding a permission to a role on the server automatically moves
// the UI, and the two can never drift because there is only one array.
//
// Extracted from lib/commandPalette/useCommandData.ts, which had the only
// implementation. The command palette now consumes this hook, so the sidebar and the
// palette gate on one code path instead of two — they previously disagreed, with the
// palette permission-aware and the sidebar not.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { useAuth } from '@/components/auth/AuthProvider'
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, type TeamPermission, type TeamRole } from '@/lib/team/types'
import type { WorkspaceInfoResponse } from '@/app/api/organizer/workspace/route'

export interface WorkspacePerms {
  loading:     boolean
  isOwner:     boolean
  role:        string
  permissions: TeamPermission[]
  has:         (p: TeamPermission) => boolean
  /**
   * The raw workspace response, for consumers that need more than permissions —
   * currently the workspace chip, which shows the organization name.
   *
   * Exposed so that chip does not make its own identical GET /api/organizer/workspace
   * call. Before this, one dashboard load fired that endpoint from three places (the
   * palette, the chip, and the gate-operator guard); the shell now shares one result
   * between the sidebar and the chip.
   */
  info:        WorkspaceInfoResponse | null
}

/**
 * Initial state deliberately answers `true` to every permission check.
 *
 * Optimistic, and correct for a UI gate: the alternative is a sidebar that renders
 * empty for a beat on every load and then fills in, which reads as broken. Showing a
 * row a moment early costs nothing — the route behind it still refuses. Showing a
 * blank workspace to an owner would be a visible regression on every page load.
 */
const INITIAL_PERMS: WorkspacePerms = {
  loading: true, isOwner: false, role: '', permissions: [...ALL_PERMISSIONS], has: () => true, info: null,
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await auth.currentUser?.getIdToken()
  if (!token) return null
  return { Authorization: `Bearer ${token}` }
}

// ═══ MODULE-LEVEL DEDUPE ═══════════════════════════════════════════════════
// A hook gives every caller its own state AND its own fetch. Three components use
// this (sidebar, workspace chip, command palette), so the naive version fired
// GET /api/organizer/workspace three times on every page load — measured in the
// browser, not assumed.
//
// The cache lives at module scope so all callers share ONE request:
//   • `inflight` collapses concurrent mounts onto a single promise
//   • `cached` serves later mounts (a navigation, a remount) with no request at all
//
// Keyed by uid so signing in as a different account cannot serve the previous
// account's role — the failure that would turn a caching optimisation into an
// authorization-shaped bug.
let cached: { uid: string; data: WorkspaceInfoResponse } | null = null
let inflight: { uid: string; promise: Promise<WorkspaceInfoResponse | null> } | null = null

async function fetchWorkspace(uid: string): Promise<WorkspaceInfoResponse | null> {
  if (cached?.uid === uid) return cached.data
  if (inflight?.uid === uid) return inflight.promise

  const promise = (async () => {
    const headers = await authHeaders()
    if (!headers) return null
    const res = await fetch('/api/organizer/workspace', { headers, cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json() as WorkspaceInfoResponse
    cached = { uid, data }
    return data
  })().finally(() => { if (inflight?.uid === uid) inflight = null })

  inflight = { uid, promise }
  return promise
}

/**
 * Drops the cache. Call on sign-out so the next account never reads the previous
 * account's workspace. Exported for the sign-out path rather than inferred.
 */
export function clearWorkspaceCache(): void {
  cached = null
  inflight = null
}

/**
 * Fetches the caller's workspace role once and derives their permissions.
 *
 * `enabled: false` defers the request entirely — the command palette uses this so a
 * plain dashboard load never pays for a palette that was not opened. The shell passes
 * `true`, since the sidebar needs it immediately.
 *
 * One request per mount, guarded by a ref. GET /api/organizer/workspace reads the
 * caller's team row and (for members) one profile doc — no event or registration
 * reads.
 */
export function useWorkspacePermissions(enabled = true): WorkspacePerms {
  const { user } = useAuth()
  const uid = user?.uid ?? null
  const [perms, setPerms] = useState<WorkspacePerms>(INITIAL_PERMS)

  useEffect(() => {
    if (!enabled || !uid) return
    let cancelled = false

    void (async () => {
      try {
        const data = await fetchWorkspace(uid)
        if (cancelled) return
        if (!data) { setPerms(p => ({ ...p, loading: false })); return }

        const permissions = data.isOwner
          ? [...ALL_PERMISSIONS]
          : (ROLE_PERMISSIONS[data.role as TeamRole] ?? [])

        setPerms({
          loading:     false,
          isOwner:     data.isOwner,
          role:        data.role,
          permissions,
          has:         (p) => data.isOwner || permissions.includes(p),
          info:        data,
        })
      } catch {
        // A failed lookup leaves the optimistic default in place rather than hiding
        // the workspace. The server still refuses anything this caller may not do.
        if (!cancelled) setPerms(p => ({ ...p, loading: false }))
      }
    })()

    return () => { cancelled = true }
  }, [enabled, uid])

  return perms
}
