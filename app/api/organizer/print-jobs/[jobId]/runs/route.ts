// GET  /api/organizer/print-jobs/[jobId]/runs — this job's recent print runs (history, metadata only).
// POST /api/organizer/print-jobs/[jobId]/runs — plan a combined on-demand print run.
//
// RD-PRINT-P3. Freezes (as metadata only) the ordered cards that can be printed now, the
// job's pinned template version, the sheet settings and the batch boundaries. Reports
// cards that cannot be printed and text-overflow warnings. Renders nothing; stores no
// output and no attendee data. A repeated submission with the same `requestId` returns
// the SAME run (no duplicate state).
//
// Body:  { requestId, sheet?, registrationIds?, batchCards? }
// Reply: 201 { success, run } (new) · 200 { success, run } (duplicate) · 4xx { error, code }
// Security: `certificates` permission + job ownership; header token only.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob } from '@/lib/printAssets/generationJob'
import { validateSheetSpec } from '@/lib/printAssets/sheet/layout'
import { RUN_MAX_CARDS } from '@/lib/printAssets/runs/plan'
import { createPrintRun, listPrintRunsForJob, toPrintRunView } from '@/lib/printAssets/runs/service'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

/** RD-PRINT-P4 — history: status, counts and a plain-language message per run. */
export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  const runs = await listPrintRunsForJob(jobId, authz.workspaceUid)
  return NextResponse.json({ success: true, runs: runs.map(toPrintRunView) }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  let body: { requestId?: unknown; sheet?: unknown; registrationIds?: unknown; batchCards?: unknown } = {}
  try { body = await req.json() as typeof body } catch { /* validated below */ }

  const spec = validateSheetSpec(body.sheet)
  if (!spec.ok) return NextResponse.json({ error: spec.error, code: 'INVALID_SHEET' }, { status: 400 })

  let registrationIds: string[] | undefined
  if (body.registrationIds !== undefined) {
    if (!Array.isArray(body.registrationIds) || !body.registrationIds.every(x => typeof x === 'string')) {
      return NextResponse.json({ error: 'registrationIds must be a list of ids', code: 'INVALID_SELECTION' }, { status: 400 })
    }
    registrationIds = [...new Set(body.registrationIds as string[])]
    if (registrationIds.length > RUN_MAX_CARDS) {   // refused before any read
      return NextResponse.json({ error: `A print run holds at most ${RUN_MAX_CARDS.toLocaleString('en-IN')} cards.`, code: 'TOO_MANY_CARDS' }, { status: 413 })
    }
  }
  const batchCards = typeof body.batchCards === 'number' && Number.isInteger(body.batchCards) && body.batchCards > 0 ? body.batchCards : undefined

  const out = await createPrintRun({ job, actorUid: authz.callerUid, requestId: body.requestId, spec: spec.value, registrationIds, batchCards })
  if (!out.ok) return NextResponse.json({ error: out.error, code: out.code }, { status: out.status })
  return NextResponse.json(
    { success: true, run: toPrintRunView(out.value.run) },
    { status: out.value.created ? 201 : 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
