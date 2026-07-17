// GET /api/organizer/print-jobs/[jobId] — print-generation job progress.
// Security: auth (any workspace member) + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob, toPrintJobView, type PrintGenerationJobView } from '@/lib/printAssets/generationJob'

export type GetPrintJobResponse =
  | { success: true;  job: PrintGenerationJobView }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<GetPrintJobResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, job: toPrintJobView(job) }, { headers: { 'Cache-Control': 'no-store' } })
}
