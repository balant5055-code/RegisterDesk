// POST /api/organizer/race-operations/sessions/[sessionId]/publish
//
// Publish changes ONLY the Import Session status: draft → published. No data is
// re-imported, no row is rewritten, nothing is recomputed.
//
// Guards (all enforced inside a Firestore transaction via the pure state machine in
// features/race-operations/lifecycle/transitions.ts):
//   • status must be `draft`            → 409 on a second publish
//   • storedRows > 0                    → 422
//   • ranking must have completed       → 422
//   • no OTHER published session for the same race → 409
// Plus a pre-transaction reconciliation of storedRows against the authoritative document
// count, so a half-written import cannot be published.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { publishSession } from '@/features/race-operations/services/importService'
import { serializeSession } from '@/features/race-operations/repositories/sessionRepo'
import type { ImportSessionView } from '@/features/race-operations/types/session'

type Params = { params: Promise<{ sessionId: string }> }

export interface PublishResponse {
  session: ImportSessionView
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  const outcome = await publishSession({
    sessionId, workspaceUid: authz.workspaceUid, callerUid: authz.callerUid,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const payload: PublishResponse = { session: serializeSession(outcome.value) }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
