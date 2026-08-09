// POST /api/organizer/race-operations/sessions/[sessionId]/cancel
//
// The Sprint 3 rollback path: draft → cancelled. A SOFT transition — the stored rows are
// KEPT for audit, and a cancelled session is invisible to every live read and can never be
// published. Nothing is deleted.
//
// A PUBLISHED session cannot be cancelled: unpublish is deliberately out of Sprint 3's
// scope (see docs/RD-RACEOPS-FIRESTORE.md §6).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { cancelSession } from '@/features/race-operations/services/importService'
import { serializeSession } from '@/features/race-operations/repositories/sessionRepo'
import type { ImportSessionView } from '@/features/race-operations/types/session'

type Params = { params: Promise<{ sessionId: string }> }

export interface CancelResponse {
  session: ImportSessionView
}

const MAX_REASON_LENGTH = 500

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  let reason: string | undefined
  try {
    const body = await req.json() as { reason?: unknown }
    if (typeof body.reason === 'string' && body.reason.trim() !== '') {
      reason = body.reason.trim().slice(0, MAX_REASON_LENGTH)
    }
  } catch {
    // A body is optional for cancel — absent or unparseable means "no reason given".
  }

  const outcome = await cancelSession({
    sessionId, workspaceUid: authz.workspaceUid, callerUid: authz.callerUid, reason,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const payload: CancelResponse = { session: serializeSession(outcome.value) }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
