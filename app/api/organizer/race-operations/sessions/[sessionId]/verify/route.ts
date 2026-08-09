// POST /api/organizer/race-operations/sessions/[sessionId]/verify
//
// RD-RESULTS-FIX-01 · Cross-checks a draft import against the event's confirmed start list.
//
// Runs in ONE call rather than the drive-loop the other passes use: `MISSING_RESULT` is only
// answerable over the complete set, and the roster + row caps keep it bounded. The counts are
// recorded on the session, and publishing refuses without them — see lifecycle/transitions.
//
// Authorization is the module's existing `authorizeRaceOps` (workspace owner or an `admin`
// team member). No new permission model.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { verifySessionRegistrations } from '@/features/race-operations/services/registrationVerify'
import { getOwnedSession, serializeSession } from '@/features/race-operations/repositories/sessionRepo'
import type { RegistrationCheckResult } from '@/features/race-operations/services/registrationVerify'
import type { ImportSessionView } from '@/features/race-operations/types/session'

type Params = { params: Promise<{ sessionId: string }> }

export interface VerifyResponse extends RegistrationCheckResult {
  session: ImportSessionView
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  const outcome = await verifySessionRegistrations({ sessionId, workspaceUid: authz.workspaceUid })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  // Re-read so the client renders the PERSISTED counts, not a local copy that could drift
  // from what the publish guard will read.
  const after = await getOwnedSession(sessionId, authz.workspaceUid)
  if (!after) return NextResponse.json({ error: 'Import session not found' }, { status: 404 })

  const payload: VerifyResponse = { ...outcome.value, session: serializeSession(after) }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
