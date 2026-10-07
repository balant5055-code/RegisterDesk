// GET /api/organizer/race-operations/races/template?eventId=…&passId=…&format=xlsx|csv
//
// RD-RACEOPS-02C · The empty results template: the canonical column headers (derived from
// RESULT_FIELDS — never a hand-written list) and, for XLSX, the "How to fill" sheet. No
// example rows: an unfilled template has a header and nothing else, which the parser
// reports as "no result rows" rather than importing an example as a result.
//
// The race is required so the workbook can name the event and race it is for; nothing
// participant-shaped is read.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import { resultsCsv, resultsWorkbookTables, templateFileStem } from '@/features/race-operations/templates/resultsTemplate'
import { passSlug } from '@/features/race-operations/utils/publicKeys'
import { tablesToXlsx } from '@/lib/reports/xlsx'

export const dynamic = 'force-dynamic'

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
  const stem = templateFileStem('results-template', race.eventSlug, passSlug(race.passName, race.passId))

  if (format === 'csv') {
    return new NextResponse(resultsCsv(), {
      status: 200,
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${stem}.csv"` },
    })
  }
  const body = new Uint8Array(tablesToXlsx(resultsWorkbookTables([], { eventName: race.eventName, raceName: race.passName })))
  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      'Cache-Control':       'no-store',
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${stem}.xlsx"`,
    },
  })
}
