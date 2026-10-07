// RD-EVENT-19F-B — Drives ONE chunk of a timing tag import, or cancels it.
//
// Called by the organizer's browser while they watch the run, and by the
// timing-tags cron. Both go through the SAME chunk processor; the kernel's lease
// means a second caller is told `busy` rather than doing the work twice.

import { NextRequest, NextResponse } from 'next/server'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import { serializeJob } from '@/lib/jobs/serialize'
import { cancelJob } from '@/lib/jobs/kernel'
import {
  processTimingTagImportChunk, getTimingTagImportJob, TIMING_TAG_IMPORT_JOBS,
} from '@/lib/identifiers/timingTagImportJob'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Ownership is proved from the STORED job, never from the request. */
async function owned(req: NextRequest, eventId: string, jobId: string) {
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return { ok: false as const, res: NextResponse.json({ error: scope.error }, { status: scope.status }) }
  const job = await getTimingTagImportJob(jobId)
  if (!job || job.organizerUid !== scope.workspaceUid || job.eventId !== eventId) {
    return { ok: false as const, res: NextResponse.json({ error: 'Import not found' }, { status: 404 }) }
  }
  return { ok: true as const, job }
}

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const guard = await owned(req, eventId, jobId)
  if (!guard.ok) return guard.res

  const result = await processTimingTagImportChunk(jobId)
  const after  = await getTimingTagImportJob(jobId)
  return NextResponse.json(
    { ok: true, result, job: after ? serializeJob(after) : null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/** Stops a run. Rows already mapped stay mapped — the result screen says so. */
export async function DELETE(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const guard = await owned(req, eventId, jobId)
  if (!guard.ok) return guard.res

  const status = await cancelJob(TIMING_TAG_IMPORT_JOBS, jobId)
  const after = await getTimingTagImportJob(jobId)
  return NextResponse.json({ ok: true, status, job: after ? serializeJob(after) : null })
}
