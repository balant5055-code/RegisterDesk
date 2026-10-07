// CRM authorization — ROLE-based (not permission-based), per the G.2 matrix:
//   owner / admin / manager → full CRM (read + write notes/tags)
//   finance                 → donations-only, READ-only
//   gate-only roles         → denied
// Workspace-aware: all data is scoped to the caller's workspaceUid.
//
// ═══ WHY THE DENIAL IS DERIVED AND NOT A ROLE NAME ═══════════════════════════
// This used to read `ctx.role === 'checkin_staff'`, which was the only hard-coded team-role
// comparison left in the codebase — and it had already gone stale. `checkin_lead` is equally
// a gate-only role (its whole grant is `checkin` + `walkin`, both in GATE_PERMISSIONS) and it
// is issuable today: it sits in ASSIGNABLE_ROLES and STAFF_ROLES, and the team settings page
// offers it as "Check-in Lead". A Check-in Lead credential therefore fell through this check
// and received `scope: 'full'` with `canWrite: true` — full CRM read and write, plus the
// bulk contact EXPORT endpoint, from a credential meant only to scan at a gate.
//
// `isCheckinOnlyRole` derives the answer from the permission matrix, which is the rule the
// rest of the platform already uses (authorizeAnyWorkspace, isEventInScope). A future
// gate-only role is contained automatically instead of needing this line edited again.

import { verifyCaller } from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { isCheckinOnlyRole } from '@/lib/team/types'
import type { CrmScope } from '@/lib/crm/types'

export interface CrmAuthz {
  ok: boolean
  status: number
  error: string
  workspaceUid: string
  role: string
  scope: CrmScope
  canWrite: boolean
}

const deny = (status: number, error: string): CrmAuthz =>
  ({ ok: false, status, error, workspaceUid: '', role: '', scope: 'full', canWrite: false })

export async function authorizeCrm(req: Request): Promise<CrmAuthz> {
  const caller = await verifyCaller(req)
  if (!caller) return deny(401, 'Unauthorized')

  const ctx = await resolveWorkspaceUid(caller.uid)
  // An OWNER is never gate-only, so the isOwner short-circuit is not needed here —
  // ctx.role is 'owner' for them and ROLE_PERMISSIONS.owner is the full set.
  if (isCheckinOnlyRole(ctx.role)) return deny(403, 'CRM is not available for your role.')

  const scope: CrmScope = ctx.role === 'finance' ? 'donations' : 'full'
  return {
    ok: true, status: 200, error: '',
    workspaceUid: ctx.workspaceUid,
    role: ctx.role,
    scope,
    canWrite: scope === 'full',   // finance is read-only
  }
}
