// POST /api/organizer/print-jobs/[jobId]/process — drive/resume one chunk.
// Security: auth (any workspace member) + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import type { ProcessResult } from '@/lib/jobs/runner'
import {
  getPrintGenerationJob, processPrintGenerationChunk, toPrintJobView, type PrintGenerationJobView,
} from '@/lib/printAssets/generationJob'

export type ProcessPrintJobResponse =
  | { success: true;  result: ProcessResult; job: PrintGenerationJobView | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<ProcessPrintJobResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const result = await processPrintGenerationChunk(jobId)
  const after  = await getPrintGenerationJob(jobId)
  return NextResponse.json({ success: true, result, job: after ? toPrintJobView(after) : null })
}
