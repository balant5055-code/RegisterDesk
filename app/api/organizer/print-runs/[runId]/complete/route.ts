// POST /api/organizer/print-runs/[runId]/complete — record that the browser merged every
// batch into one PDF (RD-PRINT-P3). Accepted only when EVERY batch was rendered and the
// merged page count equals the plan; idempotent. Metadata only.
// Body: { pageCount } · Security: `certificates` permission + run ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { completePrintRun, toPrintRunView } from '@/lib/printAssets/runs/service'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const { runId } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  let body: { pageCount?: unknown } = {}
  try { body = await req.json() as typeof body } catch { /* validated below */ }
  const out = await completePrintRun(runId, authz.workspaceUid, body.pageCount)
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status })
  return NextResponse.json({ success: true, run: toPrintRunView(out.value) })
}
