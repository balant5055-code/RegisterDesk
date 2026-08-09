// POST /api/organizer/race-operations/sessions/[sessionId]/rank
//
// Ranks ONE page of finishers and persists the resume cursor. Call repeatedly until
// `done` — the same drive-loop convention the registration importer uses
// (.../import/[jobId]/process). Resumable and safe to retry: a completed session returns
// done:true instead of erroring.
//
// Computes overall + pass rank ONLY. Gender / age / category ranking is explicitly out of
// Sprint 3's scope (Step 4) pending approved data sources.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { rankSessionChunk } from '@/features/race-operations/services/importService'
import { getOwnedSession, serializeSession } from '@/features/race-operations/repositories/sessionRepo'
import type { ImportSessionView } from '@/features/race-operations/types/session'

type Params = { params: Promise<{ sessionId: string }> }

export interface RankResponse {
  processed: number
  done:      boolean
  session:   ImportSessionView
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  const outcome = await rankSessionChunk({ sessionId, workspaceUid: authz.workspaceUid })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  // Re-read so the client sees the persisted rankedAt / rankedRows, not a local guess.
  const after = await getOwnedSession(sessionId, authz.workspaceUid)
  if (!after) return NextResponse.json({ error: 'Import session not found' }, { status: 404 })

  const payload: RankResponse = { ...outcome.value, session: serializeSession(after) }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
