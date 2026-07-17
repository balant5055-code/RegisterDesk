// GET /api/organizer/print-packages/[jobId] — packaging job progress.
// Security: auth (any workspace member) + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getPrintPackageJob, toPackageJobView, type PrintPackageJobView } from '@/lib/printAssets/packageJob'

export type GetPrintPackageResponse =
  | { success: true;  job: PrintPackageJobView }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<GetPrintPackageResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Package not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, job: toPackageJobView(job) }, { headers: { 'Cache-Control': 'no-store' } })
}
