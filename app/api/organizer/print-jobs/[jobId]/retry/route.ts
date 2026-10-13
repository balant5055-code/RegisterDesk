// POST /api/organizer/print-jobs/[jobId]/retry — retry failed items or regenerate.
// Security: `certificates` permission + job ownership (RD-PRINT-P0).
//
// Body: { mode?: 'retry' | 'regenerate', registrationIds?: string[] }
//   • 'retry' (default) → re-drive the job; only failed/missing items re-render.
//   • 'regenerate'      → clear outputs (all, or the given items) then re-render
//                         against the current template. Overwrites in place.
// Reuses the generic job runner — no new job, no duplicate records.
//
// RD-PRINT-BILL-P5 — a PAID badge job whose billing round has settled re-renders attendees already
// billed for free (D2); attendees NOT yet billed need the owner (D3), a confirmed `quote` (the 409
// reply carries a fresh one — D4) and enough units (402). Free and complimentary jobs are unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  getPrintGenerationJob, reopenPrintGenerationJob, toPrintJobView, type PrintGenerationJobView, type PrintBadgeQuote,
} from '@/lib/printAssets/generationJob'

// RD-PRINT-P8 (W2) — explicit route budget: this route runs a seed walk or a 50 s render chunk,
// so its limit is declared rather than left to the platform default.
export const maxDuration = 60

export type RetryPrintJobResponse =
  | { success: true;  job: PrintGenerationJobView | null }
  | { success: false; error: string; code?: string; quote?: PrintBadgeQuote }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<RetryPrintJobResponse>> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  let body: { mode?: unknown; registrationIds?: unknown; quote?: unknown } = {}
  try { body = await req.json() as typeof body } catch { /* empty body → defaults */ }
  const mode = body.mode === 'regenerate' ? 'regenerate' : 'retry'
  const registrationIds = Array.isArray(body.registrationIds)
    ? body.registrationIds.filter((v): v is string => typeof v === 'string')
    : undefined

  const res = await reopenPrintGenerationJob(jobId, {
    mode, registrationIds, isOwner: authz.isOwner, callerUid: authz.callerUid, quote: body.quote,
  })
  if (!res.ok) {
    if ('code' in res) {
      return NextResponse.json(
        { success: false, error: res.error, code: res.code, ...(res.quote ? { quote: res.quote } : {}) },
        { status: res.status },
      )
    }
    return NextResponse.json({ success: false, error: res.error }, { status: 409 })
  }

  const after = await getPrintGenerationJob(jobId)
  return NextResponse.json({ success: true, job: after ? toPrintJobView(after) : null })
}
