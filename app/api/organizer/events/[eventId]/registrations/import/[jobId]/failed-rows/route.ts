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
import { IMPORT_SHEET_PARTICIPANTS } from '@/lib/registrations/importTemplate'
import type { ReportColumn, ReportRow, ReportTable } from '@/lib/reports/types'

const ERROR_KEY = '__import_error'

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
  const headers = Array.isArray(job.headers) && job.headers.length
    ? job.headers
    : Array.from(new Set(failed.flatMap(f => Object.keys(f.cells))))   // fallback if headers weren't stored

  // Original template columns (in order) + one appended "Import Error" column.
  const columns: ReportColumn[] = [
    ...headers.map<ReportColumn>(h => ({ key: h, label: h, type: 'text' })),
    { key: ERROR_KEY, label: 'Import Error', type: 'text' },
  ]
  const rows: ReportRow[] = failed.map(f => {
    const row: ReportRow = { [ERROR_KEY]: f.error }
    for (const h of headers) row[h] = f.cells[h] ?? ''
    return row
  })

  const table: ReportTable = { id: IMPORT_SHEET_PARTICIPANTS, title: IMPORT_SHEET_PARTICIPANTS, columns, rows }
  const body = new Uint8Array(tablesToXlsx([table]))
  const slug = job.eventSlug || eventId

  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="import-failed-rows-${slug}.xlsx"`,
      'Cache-Control':       'no-store',
    },
  })
}
