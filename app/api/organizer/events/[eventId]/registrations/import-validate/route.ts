// POST /api/organizer/events/[eventId]/registrations/import-validate
//
// RM-2.2B — validates parsed template rows using the SAME rules as online
// registration. READ-ONLY: it performs Firestore READS (event, counter,
// registrationClaims) but writes NOTHING and creates no registrations. The reads
// are centralized in buildImportContext (shared with the import EXECUTION route);
// this route only runs the pure engine over the resulting context.
//
// Body:  { rows: Record<string,string>[], headers: string[], metadata }
// Reply: { eventStopped? , validatedRows, statistics }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }    from '@/lib/team/workspace'
import { validateImportRows }    from '@/lib/registrations/importValidation'
import { buildImportContext }    from '@/lib/registrations/importContext'
import { IMPORT_MAX_ROWS }       from '@/lib/registrations/importTemplate'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  let body: { rows?: unknown; headers?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const rows    = Array.isArray(body.rows)    ? (body.rows    as Record<string, string>[]) : null
  const headers = Array.isArray(body.headers) ? (body.headers as string[])                 : null
  if (!rows || !headers) return NextResponse.json({ error: 'rows[] and headers[] are required' }, { status: 400 })
  if (rows.length > IMPORT_MAX_ROWS) {
    return NextResponse.json({ error: `Too many rows (max ${IMPORT_MAX_ROWS}).` }, { status: 400 })
  }

  const built = await buildImportContext(uid, eventId, rows)
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })

  if (built.stopped) {
    return NextResponse.json({
      eventStopped:  { reason: built.stopped.reason, message: built.stopped.message },
      validatedRows: [],
      statistics:    { total: rows.length, readyCount: 0, warningCount: 0, duplicateCount: 0, errorCount: 0 },
    })
  }

  const result = validateImportRows(rows, headers, built.ctx)
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
