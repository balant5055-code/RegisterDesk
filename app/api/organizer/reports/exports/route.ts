// POST /api/organizer/reports/exports
//
// OE-3 — Creates a background report-export job (reusing the existing report
// registry + builders + serializers) and drives the first chunk. The create call
// returns immediately with a jobId; generation runs off the request thread (first
// chunk inline + the report-exports cron). Security: auth + the report's own
// permission.
//
// Body:  { kind, format: 'csv'|'xlsx'|'pdf', filters?: { from,to,event,campaign,status } }
// Reply: { success, jobId, job }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import { ORGANIZER_REPORTS }   from '@/lib/reports/registry'
import {
  createReportExportJob, processReportExportChunk, getReportExportJob,
  toExportJobView, isReportFileFormat, type ReportExportJobView,
} from '@/lib/reports/exportJob'
import type { ReportFilters } from '@/lib/reports/types'

export type CreateReportExportResponse =
  | { success: true;  jobId: string; job: ReportExportJobView }
  | { success: false; error: string }

function parseFilters(raw: unknown): ReportFilters {
  const b = (raw ?? {}) as Record<string, unknown>
  const f: ReportFilters = {}
  if (typeof b.from     === 'string') f.from     = b.from
  if (typeof b.to       === 'string') f.to       = b.to
  if (typeof b.event    === 'string') f.event    = b.event
  if (typeof b.campaign === 'string') f.campaign = b.campaign
  if (typeof b.status   === 'string') f.status   = b.status
  return f
}

export async function POST(req: NextRequest): Promise<NextResponse<CreateReportExportResponse>> {
  let body: { kind?: unknown; format?: unknown; filters?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const kind = typeof body.kind === 'string' ? body.kind : ''
  const meta = ORGANIZER_REPORTS[kind]
  if (!meta) return NextResponse.json({ success: false, error: 'Unknown report kind' }, { status: 400 })

  // The report's own permission gates who may generate it (same as the sync route).
  const authz = await authorizeWorkspace(req, meta.permission)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  if (!isReportFileFormat(body.format)) {
    return NextResponse.json({ success: false, error: 'format must be csv, xlsx or pdf' }, { status: 400 })
  }

  const filters   = parseFilters(body.filters)
  const datePart  = filters.from || filters.to ? `_${filters.from ?? 'start'}_${filters.to ?? 'now'}` : ''
  const filenameBase = `${kind}${datePart}`

  const job = await createReportExportJob({
    kind, format: body.format, filenameBase, heading: meta.label, filters,
    organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
  })

  await processReportExportChunk(job.jobId)   // build/serialize/persist the first (only) chunk
  const after = await getReportExportJob(job.jobId)

  return NextResponse.json(
    { success: true, jobId: job.jobId, job: toExportJobView(after ?? job) },
    { status: 201 },
  )
}
