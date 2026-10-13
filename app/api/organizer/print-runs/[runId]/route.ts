// GET /api/organizer/print-runs/[runId] — a combined print run's plan and progress (RD-PRINT-P3).
// Metadata only. Security: `certificates` permission + run ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintRun, toPrintRunView } from '@/lib/printAssets/runs/service'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const run = await getPrintRun(runId)
  if (!run || run.organizerUid !== authz.workspaceUid) return NextResponse.json({ error: 'Print run not found' }, { status: 404 })
  return NextResponse.json({ success: true, run: toPrintRunView(run) }, { headers: { 'Cache-Control': 'no-store' } })
}
