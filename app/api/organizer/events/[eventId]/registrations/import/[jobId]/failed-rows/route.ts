// GET /api/organizer/events/[eventId]/registrations/import/[jobId]/failed-rows
//
// RM-2.3B — Downloads an .xlsx of ONLY the failed rows for an import job, in the
// SAME column layout as the original template plus one appended "Import Error"
// column. The organizer fixes these rows and re-imports; already-created rows are
// not affected. Reuses the dependency-free XLSX writer. Security: auth + ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { tablesToXlsx }       from '@/lib/reports/xlsx'
import {
  REGISTRATION_IMPORT_JOBS, listFailedImportRows, type RegistrationImportJob,
} from '@/lib/registrations/importJob'
import { IMPORT_SHEET_PARTICIPANTS, importMetaTable } from '@/lib/registrations/importTemplate'
import type { ReportColumn, ReportRow, ReportTable } from '@/lib/reports/types'

const ERROR_KEY = '__import_error'
const ROW_KEY   = '__import_row'
const ERROR_LABEL = 'Import Error'
const ROW_LABEL   = 'Row in Uploaded File'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationImportJob>(REGISTRATION_IMPORT_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const failed  = await listFailedImportRows(jobId)
  const stored  = Array.isArray(job.headers) && job.headers.length
    ? job.headers
    : Array.from(new Set(failed.flatMap(f => Object.keys(f.cells))))   // fallback if headers weren't stored
  // A re-imported failed-rows file carries the two appended columns; never repeat them.
  const headers = stored.filter(h => h !== ERROR_LABEL && h !== ROW_LABEL)

  // Original template columns (in order) + appended "Import Error" and "Row in Uploaded File"
  // columns (RD-IMPORT-ROWNUM-01: the real spreadsheet row, header = row 1, blank rows
  // counted). Neither appended column is a template column, so re-import ignores both.
  const columns: ReportColumn[] = [
    ...headers.map<ReportColumn>(h => ({ key: h, label: h, type: 'text' })),
    { key: ERROR_KEY, label: ERROR_LABEL, type: 'text' },
    { key: ROW_KEY,   label: ROW_LABEL,   type: 'text' },
  ]
  const rows: ReportRow[] = failed.map(f => {
    const row: ReportRow = { [ERROR_KEY]: f.error, [ROW_KEY]: f.rowNumber === null ? '' : String(f.rowNumber) }
    for (const h of headers) row[h] = f.cells[h] ?? ''
    return row
  })

  const slug = job.eventSlug || eventId
  // RD-IMPORT-RT-01 — the drawer tells the organizer to "fix them, and re-import". Without the
  // Meta sheet the parser refused this very file ("missing its template metadata"). Same Meta
  // contract as the template (the extra "Import Error" column is ignored on re-import), and
  // Text columns so fixing a row in Excel does not mangle phones, codes or dates.
  const table: ReportTable = { id: IMPORT_SHEET_PARTICIPANTS, title: IMPORT_SHEET_PARTICIPANTS, columns, rows, textColumns: true }
  const body = new Uint8Array(tablesToXlsx([table, importMetaTable(eventId, slug)]))

  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="import-failed-rows-${slug}.xlsx"`,
      'Cache-Control':       'no-store',
    },
  })
}
