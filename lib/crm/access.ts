// CRM authorization — ROLE-based (not permission-based), per the G.2 matrix:
//   owner / admin / manager → full CRM (read + write notes/tags)
//   finance                 → donations-only, READ-only
//   checkin_staff           → denied
// Workspace-aware: all data is scoped to the caller's workspaceUid.

import { verifyCaller } from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
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
  if (ctx.role === 'checkin_staff') return deny(403, 'CRM is not available for your role.')

  const scope: CrmScope = ctx.role === 'finance' ? 'donations' : 'full'
  return {
    ok: true, status: 200, error: '',
    workspaceUid: ctx.workspaceUid,
    role: ctx.role,
    scope,
    canWrite: scope === 'full',   // finance is read-only
  }
}
