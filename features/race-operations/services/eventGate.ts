// RD-RACEOPS-02B · Race Operations — the event-capability gate for SESSION-scoped work.
//
// SERVER ONLY.
//
// `resolveRace` gates everything that names an event directly (create a session, list or
// restore versions, export, build a snapshot). The operations that name a SESSION — append
// rows, verify, rank, publish, cancel, read — used to prove only ownership
// (`getOwnedSession`). That left one door: a session created for an event whose type no
// longer admits Race Operations could still be advanced and published. This helper closes
// it by composing the two checks the platform already has, in the order the routes need:
//
//   1. the session exists and belongs to this workspace   (`getOwnedSession`, unchanged)
//   2. the session's event still admits Race Operations   (`resolveRaceOpsEvent`, ONE
//      draft read, the same rule the sidebar and the access gate apply)
//
// Both must pass. Role authorization is NOT here — `authorizeRaceOps` runs first in every
// route handler, before this is reached; this decides the EVENT, never the person.

import { getOwnedSession } from '@/features/race-operations/repositories/sessionRepo'
import { resolveRaceOpsEvent } from '@/features/race-operations/repositories/eventReadRepo'
import type { ImportSessionDoc } from '@/features/race-operations/types/session'

export type EligibleSessionOutcome =
  | { ok: true;  session: ImportSessionDoc }
  | { ok: false; status: number; error: string }

export async function requireEligibleSession(
  sessionId:    string,
  workspaceUid: string,
): Promise<EligibleSessionOutcome> {
  const session = await getOwnedSession(sessionId, workspaceUid)
  if (!session) return { ok: false, status: 404, error: 'Import session not found' }
  const gate = await resolveRaceOpsEvent(workspaceUid, session.eventId)
  if (!gate.ok) return { ok: false, status: gate.status, error: gate.error }
  return { ok: true, session }
}
