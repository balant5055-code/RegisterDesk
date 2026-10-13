// GET /api/organizer/print-jobs/[jobId]/items — generated assets for a job.
//
// Returns the per-registration results (name, ticket, ready/failed). Name and ticket
// are read from the LIVE registration (RD-PRINT-P0: items hold no attendee copy). No
// storage path or URL is ever returned — legacy items' stored ones included; each card
// is rendered on demand by the per-item download route. Security: `certificates` permission + job ownership (RD-PRINT-P0).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  getPrintGenerationJob, listPrintJobItemViews, type PrintJobItemView,
} from '@/lib/printAssets/generationJob'

export type GetPrintJobItemsResponse =
  | { success: true;  items: PrintJobItemView[] }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<GetPrintJobItemsResponse>> {
  const { jobId } = await params
  // RD-PRINT-P0 — print outputs carry attendee credentials: `certificates` (the permission
  // that creates them), not merely "any non-gate member".
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const items = await listPrintJobItemViews(jobId)
  return NextResponse.json({ success: true, items }, { headers: { 'Cache-Control': 'no-store' } })
}
