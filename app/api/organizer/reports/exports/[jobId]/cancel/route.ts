// POST /api/organizer/reports/exports/[jobId]/cancel — cancel a report-export job.
// Reuses the generic kernel cancelJob(). Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { cancelJob }            from '@/lib/jobs/kernel'
import { getReportExportJob, REPORT_EXPORT_JOBS } from '@/lib/reports/exportJob'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getReportExportJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Export not found' }, { status: 404 })
  }

  const status = await cancelJob(REPORT_EXPORT_JOBS, jobId)
  if (!status) return NextResponse.json({ success: false, error: 'Export not found' }, { status: 404 })
  return NextResponse.json({ success: true, status })
}
