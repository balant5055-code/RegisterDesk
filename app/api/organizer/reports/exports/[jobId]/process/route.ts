// POST /api/organizer/reports/exports/[jobId]/process — drive/resume one chunk.
// Security: auth (any workspace member) + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import type { ProcessResult } from '@/lib/jobs/runner'
import {
  getReportExportJob, processReportExportChunk, toExportJobView, type ReportExportJobView,
} from '@/lib/reports/exportJob'

export type ProcessReportExportResponse =
  | { success: true;  result: ProcessResult; job: ReportExportJobView | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<ProcessReportExportResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getReportExportJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Export not found' }, { status: 404 })
  }

  const result = await processReportExportChunk(jobId)
  const after  = await getReportExportJob(jobId)
  return NextResponse.json({ success: true, result, job: after ? toExportJobView(after) : null })
}
