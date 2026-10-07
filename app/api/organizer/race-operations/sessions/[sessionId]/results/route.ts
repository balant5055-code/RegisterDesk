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
import { requireEligibleSession } from '@/features/race-operations/services/eventGate'
import { fetchResultPage } from '@/features/race-operations/repositories/resultRepo'
import { RESULTS_PREVIEW_PAGE_SIZE } from '@/features/race-operations/import'
import type { NormalizedRaceResult, NormalizedRaceSplit, RaceResultStatus } from '@/features/race-operations/types/results'
import { MAX_SPLITS_PER_RESULT } from '@/features/race-operations/types/results'
import { parseTimeOfDay, MAX_RACE_DURATION_MS } from '@/features/race-operations/import/validation/time'
import { parseRaceDistance, MAX_DISTANCE_METRES } from '@/features/race-operations/import/validation/distance'
import { splitKey } from '@/features/race-operations/import/splits/splitSheet'
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

/** Longest checkpoint name accepted. It reaches a public table. */
const MAX_SPLIT_NAME_LENGTH = 40
/** A checkpoint cannot be further into a race than the race's own ceiling. */
const MAX_SPLIT_TIME_MS     = MAX_RACE_DURATION_MS
const MAX_SPLIT_DISTANCE_M  = MAX_DISTANCE_METRES

/**
 * RD-RACEOPS-RESULTS-04 · the distance a row gets.
 *
 * Re-derived from `distanceRaw` with the same closed unit table the browser used. A client
 * that sends `distanceMeters: 5` for a 10 km race cannot halve everyone's pace, and a
 * distance with no unit is refused here exactly as it is there.
 */
function distanceFrom(r: Record<string, unknown>): number | null {
  const raw = str(r.distanceRaw)
  if (raw === null) return null
  const parsed = parseRaceDistance(raw)
  return parsed.ok ? parsed.meters : null
}

/**
 * RD-RACEOPS-RESULTS-04 · parses ONE untrusted checkpoint.
 *
 * Same stance as `parseRow`: total, strict, and shape-only. Every field is bounded, because
 * a split reaches a PUBLIC page — the name is capped, the times must be finite and
 * non-negative milliseconds, and `timeOfDay` must look like a clock reading rather than any
 * string the client felt like sending. The service re-derives `sequence` and `splitKey` and
 * re-checks the whole array, so nothing here is trusted for meaning.
 */
function parseSplit(raw: unknown): NormalizedRaceSplit | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>

  const name = typeof s.name === 'string' ? s.name.trim().slice(0, MAX_SPLIT_NAME_LENGTH) : ''
  if (name === '') return null

  const ms = (v: unknown): number | null => {
    const n = num(v)
    return n !== null && n >= 0 && Number.isFinite(n) && n <= MAX_SPLIT_TIME_MS ? Math.round(n) : null
  }
  const metres = (v: unknown): number | null => {
    const n = num(v)
    return n !== null && n > 0 && n <= MAX_SPLIT_DISTANCE_M ? Math.round(n) : null
  }
  const cumulativeTimeMs = ms(s.cumulativeTimeMs)
  const segmentTimeMs    = ms(s.segmentTimeMs)
  // A checkpoint with no time says nothing; the pure layer refuses it too.
  if (cumulativeTimeMs === null && segmentTimeMs === null) return null

  const tod = typeof s.timeOfDay === 'string' ? parseTimeOfDay(s.timeOfDay) : null

  return {
    sequence:         1,                     // re-derived below, in file order
    splitKey:         splitKey(name),
    name,
    distanceMeters:   metres(s.distanceMeters),
    segmentMeters:    metres(s.segmentMeters),
    cumulativeTimeMs,
    segmentTimeMs,
    timeOfDay:        tod !== null && tod.ok ? tod.value : null,
  }
}

/**
 * Parses a row's checkpoints: bounded in number, unique by `splitKey`, and resequenced.
 *
 * Uniqueness is enforced HERE as well as in the browser's pure layer, because this is the
 * only gate a hand-made request passes through — two checkpoints with the same key would
 * publish a leg nobody ran.
 */
function parseSplits(raw: unknown): NormalizedRaceSplit[] {
  if (!Array.isArray(raw)) return []
  const out: NormalizedRaceSplit[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (out.length >= MAX_SPLITS_PER_RESULT) break
    const split = parseSplit(entry)
    if (split === null || split.splitKey === '' || seen.has(split.splitKey)) continue
    seen.add(split.splitKey)
    out.push({ ...split, sequence: out.length + 1 })
  }
  return out
}

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
    // RD-RACEOPS-RESULTS-04 · distance is re-parsed from the RAW cell rather than trusting
    // the client's metres, so the unit rule in validation/distance.ts is the only way a
    // distance can ever be set.
    distanceMeters: distanceFrom(r),
    distanceRaw:    str(r.distanceRaw),
    splits:         parseSplits(r.splits),
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
  // RD-RACEOPS-02B · and the event must still admit Race Operations.
  const gated = await requireEligibleSession(sessionId, authz.workspaceUid)
  if (!gated.ok) return NextResponse.json({ error: gated.error }, { status: gated.status })

  const cursorParam = new URL(req.url).searchParams.get('cursor')
  const cursor = cursorParam !== null && Number.isFinite(Number(cursorParam))
    ? Number(cursorParam)
    : null

  const page = await fetchResultPage(sessionId, RESULTS_PREVIEW_PAGE_SIZE, cursor)
  const payload: ResultPageResponse = page
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
