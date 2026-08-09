// POST /api/organizer/race-operations/sessions/[sessionId]/results
//   Appends ONE chunk of validated rows as DRAFT results. Idempotent: row ids are
//   deterministic, so a retried chunk overwrites rather than duplicates.
//
// GET  /api/organizer/race-operations/sessions/[sessionId]/results?cursor=
//   A page of stored rows in FILE order, for the organizer's review screen.
//
// RD-RACEOPS-01 Sprint 3. Nothing here publishes anything.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { appendResults, RESULT_CHUNK_SIZE } from '@/features/race-operations/services/importService'
import { getOwnedSession } from '@/features/race-operations/repositories/sessionRepo'
import { fetchResultPage } from '@/features/race-operations/repositories/resultRepo'
import { RESULTS_PREVIEW_PAGE_SIZE } from '@/features/race-operations/import'
import type { NormalizedRaceResult, RaceResultStatus } from '@/features/race-operations/types/results'
import type { StoredResultView } from '@/features/race-operations/types/session'

type Params = { params: Promise<{ sessionId: string }> }

export interface AppendResultsResponse {
  written:     number
  storedRows:  number
  chunkValid:   number
  chunkWarning: number
  chunkError:   number
}

export interface ResultPageResponse {
  rows:       StoredResultView[]
  nextCursor: number | null
}

const VALID_STATUSES = new Set<RaceResultStatus>(['finished', 'dnf', 'dns', 'dq'])

/** Runner names reach a public page — bound the stored length. */
const MAX_NAME_LENGTH = 120

const str  = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const num  = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Parses ONE untrusted row into the canonical model.
 *
 * Deliberately strict and total: unknown properties are dropped, wrong types become null,
 * and an unrecognised status is rejected. The service then re-runs the real validation
 * engine over the parsed rows — this function only guarantees the SHAPE.
 */
function parseRow(raw: unknown): NormalizedRaceResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const rowNumber = num(r.rowNumber)
  if (rowNumber === null || rowNumber < 1 || !Number.isInteger(rowNumber)) return null

  const status = typeof r.status === 'string' && VALID_STATUSES.has(r.status as RaceResultStatus)
    ? r.status as RaceResultStatus
    : null
  if (status === null) return null

  // rawRow: keep only string→string entries, so an attacker cannot smuggle nested objects
  // into Firestore through it.
  const rawRow: Record<string, string> = {}
  if (typeof r.rawRow === 'object' && r.rawRow !== null) {
    for (const [k, v] of Object.entries(r.rawRow as Record<string, unknown>)) {
      if (typeof v === 'string') rawRow[k] = v
    }
  }

  return {
    rowNumber,
    // Trimmed and length-capped: this is untrusted third-party file content that ends up
    // on a PUBLIC page, so it must not be able to carry an unbounded payload.
    participantName: typeof r.participantName === 'string' && r.participantName.trim() !== ''
      ? r.participantName.trim().slice(0, MAX_NAME_LENGTH)
      : null,
    bibNumber:      str(r.bibNumber),
    chipTimeMs:     num(r.chipTimeMs),
    gunTimeMs:      num(r.gunTimeMs),
    chipTimeRaw:    str(r.chipTimeRaw),
    gunTimeRaw:     str(r.gunTimeRaw),
    status,
    statusRaw:      str(r.statusRaw),
    gender:         str(r.gender),
    category:       str(r.category),
    ageGroup:       str(r.ageGroup),
    rawRow,
    sourceProvider: str(r.sourceProvider) ?? 'unknown',
  }
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  let body: { results?: unknown }
  try { body = await req.json() as { results?: unknown } }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  if (!Array.isArray(body.results)) {
    return NextResponse.json({ error: 'results[] is required' }, { status: 400 })
  }
  if (body.results.length > RESULT_CHUNK_SIZE) {
    return NextResponse.json(
      { error: `Send at most ${RESULT_CHUNK_SIZE} rows per request.` },
      { status: 413 },
    )
  }

  const parsed: NormalizedRaceResult[] = []
  for (const raw of body.results) {
    const row = parseRow(raw)
    if (row === null) {
      return NextResponse.json({ error: 'One or more rows were malformed.' }, { status: 400 })
    }
    parsed.push(row)
  }

  const outcome = await appendResults({ sessionId, workspaceUid: authz.workspaceUid, results: parsed })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const payload: AppendResultsResponse = outcome.value
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params

  // Tenant check before any subcollection read: an unowned session reads as absent.
  const session = await getOwnedSession(sessionId, authz.workspaceUid)
  if (!session) return NextResponse.json({ error: 'Import session not found' }, { status: 404 })

  const cursorParam = new URL(req.url).searchParams.get('cursor')
  const cursor = cursorParam !== null && Number.isFinite(Number(cursorParam))
    ? Number(cursorParam)
    : null

  const page = await fetchResultPage(sessionId, RESULTS_PREVIEW_PAGE_SIZE, cursor)
  const payload: ResultPageResponse = page
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
