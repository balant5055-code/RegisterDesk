// GET /api/organizer/workspace
//
// Returns the caller's effective workspace identity for the dashboard banner:
// whether they are the owner of their own workspace or an active team member of
// another organizer, plus that workspace's organization name and their role.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { verifyCaller }              from '@/lib/team/access'
import { resolveWorkspaceUid }       from '@/lib/team/workspace'
import { isCheckinOnlyRole }         from '@/lib/team/types'

export interface WorkspaceInfoResponse {
  isOwner:          boolean
  role:             string
  organizationName: string
  workspaceUid:     string
  /**
   * RD-CHECKIN-STAFF-01 — the events this caller is assigned to ([] = all).
   *
   * Exposed so the dashboard shell can send a gate-only operator to their own
   * console instead of an organizer page that would only refuse them. This is a
   * ROUTING hint, never a permission: every organizer route re-authorizes server
   * side, so a client that ignores it gains nothing.
   */
  eventIds:         string[]
  /** True when the caller's whole grant is gate check-in. */
  checkinOnly:      boolean
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await resolveWorkspaceUid(caller.uid)

  let organizationName = 'Personal Workspace'
  if (!ctx.isOwner) {
    const snap = await adminDb.doc(`users/${ctx.workspaceUid}`).get()
    organizationName = (snap.data()?.organizationName as string) || 'Shared Workspace'
  }

  const body: WorkspaceInfoResponse = {
    isOwner:          ctx.isOwner,
    role:             ctx.role,
    organizationName,
    workspaceUid:     ctx.workspaceUid,
    eventIds:         ctx.eventIds,
    checkinOnly:      !ctx.isOwner && isCheckinOnlyRole(ctx.role),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
