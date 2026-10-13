// POST /api/organizer/print-runs/[runId]/fail — the browser could not finish the combined
// PDF (e.g. a batch still failed after retries), so nothing was downloaded (RD-PRINT-P3).
// Marks a planned run failed; idempotent. Metadata only (a short, sanitised reason).
// Body: { reason? } · Security: `certificates` permission + run ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { failPrintRun, toPrintRunView } from '@/lib/printAssets/runs/service'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  // RD-PRINT-AUDIT · the request body is ignored: the stored failure message is fixed.
  const out = await failPrintRun(runId, authz.workspaceUid)
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status })
  return NextResponse.json({ success: true, run: toPrintRunView(out.value) })
}
