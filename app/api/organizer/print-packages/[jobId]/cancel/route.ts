// POST /api/organizer/print-packages/[jobId]/cancel — cancel a packaging job.
// Reuses the generic kernel cancelJob(). Security: `certificates` permission + job ownership (RD-PRINT-P0).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { cancelJob }            from '@/lib/jobs/kernel'
import { getPrintPackageJob, PRINT_PACKAGE_JOBS } from '@/lib/printAssets/packageJob'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Package not found' }, { status: 404 })
  }

  const status = await cancelJob(PRINT_PACKAGE_JOBS, jobId)
  if (!status) return NextResponse.json({ success: false, error: 'Package not found' }, { status: 404 })
  return NextResponse.json({ success: true, status })
}
