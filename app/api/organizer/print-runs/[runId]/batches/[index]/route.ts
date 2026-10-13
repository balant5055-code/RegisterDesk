// POST /api/organizer/print-runs/[runId]/batches/[index] — render ONE batch of a combined
// print run as a PDF of whole sheets (RD-PRINT-P3).
//
// Renders exactly the batch's slice of the run's FROZEN card order, from the job's PINNED
// template version and the LIVE registrations, in memory, returned with `no-store`.
// Strict: a registration cancelled/refunded/removed since planning fails the batch (409
// REGISTRATION_CHANGED, with the ids) and the run — never a silently shorter batch.
// Re-requesting a batch renders the same cards again (retry-safe).
// Security: `certificates` permission + run AND job ownership; header token only.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob } from '@/lib/printAssets/generationJob'
import { getPrintRun, renderRunBatch } from '@/lib/printAssets/runs/service'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ runId: string; index: string }> },
): Promise<NextResponse> {
  const { runId, index } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const run = await getPrintRun(runId)
  if (!run || run.organizerUid !== authz.workspaceUid) return NextResponse.json({ error: 'Print run not found' }, { status: 404 })
  const job = await getPrintGenerationJob(run.jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) return NextResponse.json({ error: 'Print run not found' }, { status: 404 })

  const i = /^\d{1,4}$/.test(index) ? Number(index) : -1
  const out = await renderRunBatch(run, job, i)
  if (!out.ok) {
    return NextResponse.json(
      { error: out.error, code: out.code, ...(out.registrationIds ? { registrationIds: out.registrationIds.slice(0, 200) } : {}) },
      { status: out.status },
    )
  }
  return new NextResponse(Buffer.from(out.bytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':           'application/pdf',
      'Content-Disposition':    `attachment; filename="${out.filename}"`,
      'Cache-Control':          'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'X-Print-Batch-Index':    String(i),
      'X-Print-Card-Count':     String(out.cards),
      'X-Print-Sheet-Count':    String(out.sheets),
    },
  })
}
