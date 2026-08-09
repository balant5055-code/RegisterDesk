// POST /api/organizer/race-operations/sessions      — create an immutable Import Session
// GET  /api/organizer/race-operations/sessions?eventId=…  — sessions for one event
//
// RD-RACEOPS-01 Sprint 3. Race Operations' FIRST API routes.
//
// Authorization: `requireAdmin` — workspace owner or an `admin` team member. This reuses
// the existing role matrix (lib/team/types.ts) exactly as the Phase 0 audit prescribed;
// no permission is added. Thin by design: authorize → parse → service → respond.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import {
  createImportSession, RESULT_CHUNK_SIZE,
} from '@/features/race-operations/services/importService'
import {
  listSessionsForEvent, serializeSession,
} from '@/features/race-operations/repositories/sessionRepo'
import type { ColumnMapping, ResultField } from '@/features/race-operations/types/results'
import { RESULT_FIELDS } from '@/features/race-operations/types/results'
import type { ImportSessionView } from '@/features/race-operations/types/session'

export interface CreateSessionResponse {
  session:   ImportSessionView
  /** Rows the client may send per POST .../results call. */
  chunkSize: number
}

export interface ListSessionsResponse {
  sessions: ImportSessionView[]
}

const VALID_FIELDS = new Set<string>(RESULT_FIELDS.map(f => f.field))

/** Accepts only known canonical fields mapped to non-empty header strings. */
function parseMapping(raw: unknown): ColumnMapping | null {
  if (typeof raw !== 'object' || raw === null) return null
  const out: ColumnMapping = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!VALID_FIELDS.has(key)) continue
    if (typeof value !== 'string' || value === '') continue
    out[key as ResultField] = value
  }
  return out
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId  = typeof body.eventId  === 'string' ? body.eventId.trim()  : ''
  const passId   = typeof body.passId   === 'string' ? body.passId.trim()   : ''
  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  const fileHash = typeof body.fileHash === 'string' ? body.fileHash.trim() : ''
  const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
  const totalRows = typeof body.totalRows === 'number' ? Math.floor(body.totalRows) : NaN
  const mapping  = parseMapping(body.mapping)

  if (!eventId || !passId) {
    return NextResponse.json({ error: 'eventId and passId are required' }, { status: 400 })
  }
  if (!fileName || !provider) {
    return NextResponse.json({ error: 'fileName and provider are required' }, { status: 400 })
  }
  if (!Number.isFinite(totalRows)) {
    return NextResponse.json({ error: 'totalRows must be a number' }, { status: 400 })
  }
  if (!mapping || !mapping.bibNumber || !mapping.chipTime) {
    return NextResponse.json(
      { error: 'mapping must include the required bibNumber and chipTime columns' },
      { status: 400 },
    )
  }

  const outcome = await createImportSession({
    workspaceUid: authz.workspaceUid,
    callerUid:    authz.callerUid,
    eventId, passId, fileName, fileHash, provider, mapping, totalRows,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const payload: CreateSessionResponse = {
    session:   serializeSession(outcome.value),
    chunkSize: RESULT_CHUNK_SIZE,
  }
  return NextResponse.json(payload, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = new URL(req.url).searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const sessions = await listSessionsForEvent(authz.workspaceUid, eventId)
  const payload: ListSessionsResponse = { sessions: sessions.map(serializeSession) }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
