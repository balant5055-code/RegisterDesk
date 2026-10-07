// GET /api/organizer/race-operations/races/start-list?eventId=…&passId=…&format=xlsx|csv
//
// RD-RACEOPS-02C · The race's start list as a results file to fill in: every confirmed
// participant of THIS pass who holds a bib, identity prefilled, result columns empty, plus
// a "How to fill" sheet. Read from the SAME roster query verification uses
// (`fetchEventRoster`), so what the organizer downloads is exactly what the import will
// later check the file against — one source of truth, read at download time.
//
// Owner/admin only (`authorizeRaceOps`); the event must be owned and admit Race Operations
// (`resolveRace`, RD-RACEOPS-02B). Nothing is written.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { fetchEventRoster, resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import {
  resultsCsv, resultsWorkbookTables, templateFileStem, type StartListEntry,
} from '@/features/race-operations/templates/resultsTemplate'
import { passSlug } from '@/features/race-operations/utils/publicKeys'
import { tablesToXlsx } from '@/lib/reports/xlsx'

export const dynamic = 'force-dynamic'

/** Numeric-aware bib order: 7 before 10, then A101 after the digits. */
const byBib = (a: StartListEntry, b: StartListEntry) =>
  a.bibNumber.localeCompare(b.bibNumber, 'en', { numeric: true, sensitivity: 'base' })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const p = req.nextUrl.searchParams
  const eventId = p.get('eventId')?.trim() ?? ''
  const passId  = p.get('passId')?.trim()  ?? ''
  const format  = p.get('format') === 'csv' ? 'csv' : 'xlsx'
  if (!eventId || !passId) {
    return NextResponse.json({ error: 'eventId and passId are required' }, { status: 400 })
  }

  const resolved = await resolveRace(authz.workspaceUid, eventId, passId)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })
  const { race } = resolved

  const { roster, truncated } = await fetchEventRoster({ organizerUid: authz.workspaceUid, eventSlug: race.eventSlug })
  const entries: StartListEntry[] = []
  for (const entry of roster.values()) {
    if (entry.passId !== passId) continue
    entries.push({ bibNumber: entry.bibKey, participantName: entry.name })
  }
  entries.sort(byBib)

  const stem = templateFileStem('start-list', race.eventSlug, passSlug(race.passName, race.passId))
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    // An organizer with more participants than the roster bound sees it in the response,
    // not silently in a shorter file.
    ...(truncated ? { 'X-RegisterDesk-Roster-Truncated': '1' } : {}),
  }

  if (format === 'csv') {
    return new NextResponse(resultsCsv(entries), {
      status: 200,
      headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${stem}.csv"` },
    })
  }
  const body = new Uint8Array(tablesToXlsx(resultsWorkbookTables(entries, {
    eventName: race.eventName, raceName: race.passName, participantCount: entries.length,
  })))
  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      ...headers,
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${stem}.xlsx"`,
    },
  })
}
