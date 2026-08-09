// POST /api/organizer/race-operations/sessions/[sessionId]/snapshot
//
// Builds ONE page of the Official Result Snapshot — the public read model. Call repeatedly
// until `done`, then call /publish, which flips the session AND the snapshot live in one
// transaction.
//
// The snapshot is built while the session is still `draft` and stays in `building` state
// until that flip, so a public page can never observe a half-copied race.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { buildSnapshotChunk } from '@/features/race-operations/services/snapshotService'

type Params = { params: Promise<{ sessionId: string }> }

export interface SnapshotBuildResponse {
  copied:     number
  done:       boolean
  version:    number
  nextCursor: number | null
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  let afterRowNumber: number | null = null
  try {
    const body = await req.json() as { cursor?: unknown }
    if (typeof body.cursor === 'number' && Number.isFinite(body.cursor)) afterRowNumber = body.cursor
  } catch {
    // No body ⇒ start from the beginning.
  }

  const outcome = await buildSnapshotChunk({
    sessionId, workspaceUid: authz.workspaceUid, afterRowNumber,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const payload: SnapshotBuildResponse = outcome.value
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
