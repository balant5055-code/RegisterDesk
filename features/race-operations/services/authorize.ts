// RD-RACEOPS-01 Sprint 3 · Route authorization — SERVER ONLY.
//
// THE single gate for every Race Operations route, so the rule is expressed once instead
// of being copy-pasted into five handlers.
//
// It composes the EXISTING primitives and adds nothing of its own:
//   verifyCaller        — token verify + checkRevoked + email_verified gate
//   resolveWorkspaceUid — owner → self; active team member → the owner's workspace
//   requireAdmin        — owner or `admin` ONLY (manager / checkin_staff / finance denied)
//
// This is the server-side authority. The client-side gate in utils/access.ts mirrors it
// for UI purposes only.

import { requireAdmin, verifyCaller } from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'

export type RaceOpsAuthz =
  | { ok: true;  callerUid: string; workspaceUid: string }
  | { ok: false; status: number; error: string }

export async function authorizeRaceOps(req: Request): Promise<RaceOpsAuthz> {
  const caller = await verifyCaller(req)
  if (!caller) return { ok: false, status: 401, error: 'Unauthorized' }

  const ctx = await resolveWorkspaceUid(caller.uid)

  // Owner or admin only — the Phase 0 decision, enforced through the existing matrix with
  // no new permission introduced.
  const access = await requireAdmin(caller.uid, ctx.workspaceUid)
  if (!access.ok) return { ok: false, status: access.status, error: access.reason }

  return { ok: true, callerUid: caller.uid, workspaceUid: ctx.workspaceUid }
}
