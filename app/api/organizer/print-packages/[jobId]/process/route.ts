// POST /api/organizer/print-packages/[jobId]/process — drive/resume one chunk.
// Security: `certificates` permission + job ownership (RD-PRINT-P0).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import type { ProcessResult } from '@/lib/jobs/runner'
import {
  getPrintPackageJob, processPrintPackageChunk, toPackageJobView, type PrintPackageJobView,
} from '@/lib/printAssets/packageJob'

// RD-PRINT-P8 (W2) — explicit route budget: this route runs a seed walk or a 50 s render chunk,
// so its limit is declared rather than left to the platform default.
export const maxDuration = 60

export type ProcessPrintPackageResponse =
  | { success: true;  result: ProcessResult; job: PrintPackageJobView | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<ProcessPrintPackageResponse>> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Package not found' }, { status: 404 })
  }

  const result = await processPrintPackageChunk(jobId)
  const after  = await getPrintPackageJob(jobId)
  return NextResponse.json({ success: true, result, job: after ? toPackageJobView(after) : null })
}
