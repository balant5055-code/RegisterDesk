// GET /api/organizer/race-operations/sessions/[sessionId]
//
// One Import Session, for the organizer's review screen. Tenant-checked: a session owned
// by another workspace reads as absent rather than forbidden, which leaks nothing.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { getOwnedSession, serializeSession } from '@/features/race-operations/repositories/sessionRepo'
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
  const session = await getOwnedSession(sessionId, authz.workspaceUid)
  if (!session) return NextResponse.json({ error: 'Import session not found' }, { status: 404 })

  const payload: SessionDetailResponse = {
    session:          serializeSession(session),
    actualStoredRows: await countStoredResults(sessionId),
  }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
