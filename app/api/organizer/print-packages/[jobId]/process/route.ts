// POST /api/organizer/print-packages/[jobId]/process — drive/resume one chunk.
// Security: auth (any workspace member) + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import type { ProcessResult } from '@/lib/jobs/runner'
import {
  getPrintPackageJob, processPrintPackageChunk, toPackageJobView, type PrintPackageJobView,
} from '@/lib/printAssets/packageJob'

export type ProcessPrintPackageResponse =
  | { success: true;  result: ProcessResult; job: PrintPackageJobView | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<ProcessPrintPackageResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Package not found' }, { status: 404 })
  }

  const result = await processPrintPackageChunk(jobId)
  const after  = await getPrintPackageJob(jobId)
  return NextResponse.json({ success: true, result, job: after ? toPackageJobView(after) : null })
}
