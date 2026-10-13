// POST /api/organizer/print-jobs/[jobId]/cancel — cancel a print-generation job.
// Reuses the generic kernel cancelJob(). Security: `certificates` permission + job ownership (RD-PRINT-P0).
// RD-PRINT-BILL-P5 — a paid badge job's open round settles right away: units already used for
// billed attendees stay used, the rest return to the event. (The cron sweep is the backstop.)

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { cancelJob }            from '@/lib/jobs/kernel'
import { getPrintGenerationJob, PRINT_GENERATION_JOBS } from '@/lib/printAssets/generationJob'
import { billingOf } from '@/lib/printAssets/badgeBilling/decisions'
import { settlePrintBadgeRound } from '@/lib/printAssets/badgeBilling/store'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const status = await cancelJob(PRINT_GENERATION_JOBS, jobId)
  if (!status) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  if (status === 'cancelled' && billingOf(job)?.mode === 'paid') {
    await settlePrintBadgeRound(jobId, 'cancelled').catch(() => { /* the print-generation cron sweep settles it */ })
  }
  return NextResponse.json({ success: true, status })
}
