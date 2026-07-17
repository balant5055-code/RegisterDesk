// GET /api/organizer/reports/exports/[jobId] — report-export job progress.
// Security: auth (any workspace member) + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getReportExportJob, toExportJobView, type ReportExportJobView } from '@/lib/reports/exportJob'

export type GetReportExportResponse =
  | { success: true;  job: ReportExportJobView }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<GetReportExportResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getReportExportJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Export not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, job: toExportJobView(job) }, { headers: { 'Cache-Control': 'no-store' } })
}
