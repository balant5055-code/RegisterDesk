// RD-RACEOPS-01 · Race Operations — access predicate.
//
// PURE. No SDK, no I/O, no React. Unit-testable in isolation.
//
// Race Operations introduces NO new permission model. The rule is expressed once,
// here, in terms of the existing role vocabulary (lib/team/types.ts), and is the
// exact client-side mirror of the server's `requireAdmin(callerUid, organizerUid)`
// (lib/team/access.ts:91-96): the workspace OWNER, or an active member whose role
// is `admin`. Every other role — manager, checkin_staff, finance — is denied.
//
// This predicate gates UI only. It is defence-in-depth, never the security
// boundary: from Sprint 3 onward every Race Operations route handler calls
// `requireAdmin` server-side, which is authoritative.

import type { TeamRole } from '@/lib/team/types'
import { RACE_OPS_ROLES } from '@/features/race-operations/types'

/** Shape of the existing GET /api/organizer/workspace payload we depend on. */
export interface RaceOpsAccessInput {
  isOwner: boolean
  role:    string
}

export function isRaceOpsRole(role: string): role is TeamRole {
  return (RACE_OPS_ROLES as readonly string[]).includes(role)
}

/** True when the caller may operate Race Operations. */
export function canAccessRaceOperations(input: RaceOpsAccessInput): boolean {
  return input.isOwner || isRaceOpsRole(input.role)
}
