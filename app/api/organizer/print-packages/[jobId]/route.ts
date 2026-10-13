// GET /api/organizer/print-packages/[jobId] — packaging job progress.
// Security: `certificates` permission + job ownership (RD-PRINT-P0).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintPackageJob, toPackageJobView, type PrintPackageJobView } from '@/lib/printAssets/packageJob'

export type GetPrintPackageResponse =
  | { success: true;  job: PrintPackageJobView }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<GetPrintPackageResponse>> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Package not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, job: toPackageJobView(job) }, { headers: { 'Cache-Control': 'no-store' } })
}
