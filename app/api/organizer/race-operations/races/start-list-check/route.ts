// POST /api/organizer/race-operations/races/start-list-check
//   { eventId, passId, bibs: string[] }
//
// RD-RACEOPS-02C · The start-list check as a DRY RUN, before anything is imported. The
// browser has validated the file against itself; this answers the question it cannot:
// are these bibs on this race's start list? Same roster reader and same pure matcher the
// post-import verification uses (`fetchEventRoster`, `matchAgainstRoster`), so the
// preview and the real check cannot disagree. Reads only; writes nothing; no session.
//
// Bounded by the upload cap (RESULTS_MAX_ROWS bibs per request).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { fetchEventRoster, resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import { RESULTS_MAX_ROWS } from '@/features/race-operations/import/constants'
import {
  hasBlockingRegistrationIssues, matchAgainstRoster, type RegistrationIssue,
} from '@/features/race-operations/import/validation/registrationMatch'
import { REGISTRATION_ISSUE_PREVIEW_LIMIT } from '@/features/race-operations/services/registrationVerify'
import { bibKey } from '@/features/race-operations/utils/publicKeys'

export interface StartListCheckResponse {
  matched:         number
  unknownRunner:   number
  wrongRace:       number
  missingResult:   number
  blocking:        boolean
  issues:          RegistrationIssue[]
  rosterTruncated: boolean
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { eventId?: unknown; passId?: unknown; bibs?: unknown }
  try { body = await req.json() as typeof body }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  const passId  = typeof body.passId  === 'string' ? body.passId.trim()  : ''
  if (!eventId || !passId) return NextResponse.json({ error: 'eventId and passId are required' }, { status: 400 })
  if (!Array.isArray(body.bibs)) return NextResponse.json({ error: 'bibs[] is required' }, { status: 400 })
  if (body.bibs.length > RESULTS_MAX_ROWS) {
    return NextResponse.json({ error: `Send at most ${RESULTS_MAX_ROWS.toLocaleString('en-IN')} bibs.` }, { status: 413 })
  }

  const resolved = await resolveRace(authz.workspaceUid, eventId, passId)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  // Each entry is { rowNumber, bib } from the browser: the row number is the file's own
  // (so an issue can cite the row the organizer sees), the bib is what they will look for.
  const rows = (body.bibs as unknown[]).map((raw, i) => {
    const item = raw && typeof raw === 'object' ? raw as { rowNumber?: unknown; bib?: unknown } : { bib: raw }
    const bib  = typeof item.bib === 'string' ? item.bib.trim() : ''
    const rowNumber = typeof item.rowNumber === 'number' && Number.isFinite(item.rowNumber) ? item.rowNumber : i + 1
    return { rowNumber, bibNumber: bib || null, bibKey: bib ? bibKey(bib) : '' }
  })

  const { roster, truncated } = await fetchEventRoster({ organizerUid: authz.workspaceUid, eventSlug: resolved.race.eventSlug })
  const result = matchAgainstRoster({ passId, rows, roster, detectMissing: !truncated })

  const payload: StartListCheckResponse = {
    matched:         result.matched,
    unknownRunner:   result.unknownRunner,
    wrongRace:       result.wrongRace,
    missingResult:   result.missingResult,
    blocking:        hasBlockingRegistrationIssues(result),
    issues:          result.issues.slice(0, REGISTRATION_ISSUE_PREVIEW_LIMIT),
    rosterTruncated: truncated,
  }
  return NextResponse.json(payload, { headers: { 'Cache-Control': 'no-store' } })
}
