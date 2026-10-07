// GET  /api/staff/me  — the signed-in staff operator's own identity and scope.
// POST /api/staff/me  — record a sign-in (called once, immediately after login).
//
// RD-CHECKIN-2.0.
//
// ═══ THE CHAIN THIS ROUTE COMPLETES ══════════════════════════════════════════
//     staff identity → staff status → event access → check-in permission
// Every link is resolved SERVER-SIDE from the token, and none of it is taken from
// the request:
//
//   • identity  — verifyCaller (Firebase ID token, checkRevoked)
//   • status    — resolveWorkspaceUid finds an ACTIVE member row, or nothing. A
//                 suspended account has no active row, so it resolves to its own
//                 empty workspace and every check below refuses it.
//   • events    — ctx.eventIds, from that member row
//   • permission— ctx.permissions, re-derived from the role matrix
//
// The `staffAccounts` document is consulted only for the operator's NAME and
// whether they still owe a password change. It grants nothing, and a caller with no
// such document simply is not a staff account.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { verifyCaller }              from '@/lib/team/access'
import { resolveWorkspaceUid }       from '@/lib/team/workspace'
import { isCheckinOnlyRole }         from '@/lib/team/types'
import { getStaffAccount, recordStaffLogin } from '@/lib/staff/service'

export const dynamic = 'force-dynamic'

export interface StaffMeResponse {
  /** False for organizers and email-invited members signing in normally. */
  isStaff:      boolean
  displayName:  string
  username:     string | null
  role:         string
  /** Effective permissions, re-derived from the matrix. Display only. */
  permissions:  string[]
  /** Events this operator may work. Always non-empty for a staff account. */
  eventIds:     string[]
  /** True when the whole grant is gate work — used to choose the landing surface. */
  gateOnly:     boolean
  /** The organization the operator is working for. */
  workspaceName: string
  /** True while a temporary password issued by the organizer is still in use. */
  mustChangePassword: boolean
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await resolveWorkspaceUid(caller.uid)
  const staff = await getStaffAccount(caller.uid)

  // A staff credential whose grant was revoked resolves to its OWN workspace
  // (isOwner true, no memberships). Reporting that as a working staff session would
  // send the operator to a gate they cannot open, so it is refused here with the
  // same wording a suspension gives.
  if (staff && ctx.isOwner) {
    return NextResponse.json(
      { error: 'This account is not active. Ask your organizer to re-enable it.' },
      { status: 403 },
    )
  }

  let workspaceName = 'Personal Workspace'
  if (!ctx.isOwner) {
    const snap = await adminDb.doc(`users/${ctx.workspaceUid}`).get()
    workspaceName = (snap.data()?.organizationName as string) || 'Shared Workspace'
  }

  const body: StaffMeResponse = {
    isStaff:     staff !== null,
    displayName: staff?.displayName || caller.email || 'Operator',
    username:    staff?.username ?? null,
    role:        ctx.role,
    permissions: ctx.permissions,
    eventIds:    ctx.eventIds,
    gateOnly:    !ctx.isOwner && isCheckinOnlyRole(ctx.role),
    workspaceName,
    mustChangePassword: staff?.mustChangePassword === true,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Records a sign-in.
 *
 * Separate from GET on purpose: GET is polled by the gate surfaces, and writing a
 * timestamp on every poll would turn a read into a write on every render. This is
 * called once, by the login form, after the credential is accepted.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const staff = await getStaffAccount(caller.uid)
  if (!staff) return NextResponse.json({ ok: true })   // not a staff account — nothing to record

  await recordStaffLogin(caller.uid).catch(err =>
    console.error('[staff/me] lastLoginAt write failed:', err))
  return NextResponse.json({ ok: true })
}
