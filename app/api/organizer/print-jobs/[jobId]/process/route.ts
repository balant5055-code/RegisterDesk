// POST /api/organizer/print-jobs/[jobId]/process — drive/resume one chunk.
// Security: `certificates` permission + job ownership (RD-PRINT-P0).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import type { ProcessResult } from '@/lib/jobs/runner'
import {
  getPrintGenerationJob, processPrintGenerationChunk, toPrintJobView, type PrintGenerationJobView,
} from '@/lib/printAssets/generationJob'

// RD-PRINT-P8 (W2) — explicit route budget: this route runs a seed walk or a 50 s render chunk,
// so its limit is declared rather than left to the platform default.
export const maxDuration = 60

export type ProcessPrintJobResponse =
  | { success: true;  result: ProcessResult; job: PrintGenerationJobView | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<ProcessPrintJobResponse>> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const result = await processPrintGenerationChunk(jobId)
  const after  = await getPrintGenerationJob(jobId)
  return NextResponse.json({ success: true, result, job: after ? toPrintJobView(after) : null })
}
