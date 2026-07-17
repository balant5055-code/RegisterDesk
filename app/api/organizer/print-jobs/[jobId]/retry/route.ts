// POST /api/organizer/print-jobs/[jobId]/retry — retry failed items or regenerate.
// Security: auth (any workspace member) + job ownership.
//
// Body: { mode?: 'retry' | 'regenerate', registrationIds?: string[] }
//   • 'retry' (default) → re-drive the job; only failed/missing items re-render.
//   • 'regenerate'      → clear outputs (all, or the given items) then re-render
//                         against the current template. Overwrites in place.
// Reuses the generic job runner — no new job, no duplicate records.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import {
  getPrintGenerationJob, reopenPrintGenerationJob, toPrintJobView, type PrintGenerationJobView,
} from '@/lib/printAssets/generationJob'

export type RetryPrintJobResponse =
  | { success: true;  job: PrintGenerationJobView | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<RetryPrintJobResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  let body: { mode?: unknown; registrationIds?: unknown } = {}
  try { body = await req.json() as typeof body } catch { /* empty body → defaults */ }
  const mode = body.mode === 'regenerate' ? 'regenerate' : 'retry'
  const registrationIds = Array.isArray(body.registrationIds)
    ? body.registrationIds.filter((v): v is string => typeof v === 'string')
    : undefined

  const res = await reopenPrintGenerationJob(jobId, { mode, registrationIds })
  if (!res.ok) return NextResponse.json({ success: false, error: res.error }, { status: 409 })

  const after = await getPrintGenerationJob(jobId)
  return NextResponse.json({ success: true, job: after ? toPrintJobView(after) : null })
}
