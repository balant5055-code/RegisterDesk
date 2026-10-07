// GET /api/organizer/race-operations/sessions/[sessionId]
//
// One Import Session, for the organizer's review screen. Tenant-checked: a session owned
// by another workspace reads as absent rather than forbidden, which leaks nothing.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { serializeSession } from '@/features/race-operations/repositories/sessionRepo'
import { requireEligibleSession } from '@/features/race-operations/services/eventGate'
import { countStoredResults } from '@/features/race-operations/repositories/resultRepo'
import type { ImportSessionView } from '@/features/race-operations/types/session'

type Params = { params: Promise<{ sessionId: string }> }

export interface SessionDetailResponse {
  session: ImportSessionView
  /** Authoritative document count, so a drifted `storedRows` counter is visible. */
  actualStoredRows: number
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params
  // RD-RACEOPS-02B · owned AND the event admits Race Operations — nothing result-shaped
  // is read for an event that does not.
  const gated = await requireEligibleSession(sessionId, authz.workspaceUid)
  if (!gated.ok) return NextResponse.json({ error: gated.error }, { status: gated.status })
  const session = gated.session

  const payload: SessionDetailResponse = {
    session:          serializeSession(session),
    actualStoredRows: await countStoredResults(sessionId),
  }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
