// GET /api/organizer/print-jobs/[jobId]/items — generated assets for a job.
//
// Returns the per-registration results (name, ticket, ready/failed, expiry). The
// stored storage path + token URL are NEVER returned — each asset downloads only
// through the secure per-item download route. Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import {
  getPrintGenerationJob, listPrintJobItems, toPrintItemView, type PrintJobItemView,
} from '@/lib/printAssets/generationJob'

export type GetPrintJobItemsResponse =
  | { success: true;  items: PrintJobItemView[] }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse<GetPrintJobItemsResponse>> {
  const { jobId } = await params
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const items = (await listPrintJobItems(jobId)).map(toPrintItemView)
  return NextResponse.json({ success: true, items }, { headers: { 'Cache-Control': 'no-store' } })
}
