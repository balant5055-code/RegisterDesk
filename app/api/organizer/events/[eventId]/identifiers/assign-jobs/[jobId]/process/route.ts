// RD-EVENT-19E — Drives ONE chunk of an identifier assignment job.
//
// Called by the client while it watches a run, and by the identifier-assign cron.
// Both go through the SAME `processIdentifierAssignmentChunk`, and the kernel's
// lease means a second caller is told `busy` rather than doing the work twice.
// Resumes from the persisted cursor, so an interrupted chunk never restarts.

import { NextRequest, NextResponse } from 'next/server'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'
import { serializeJob } from '@/lib/jobs/serialize'
import { cancelJob } from '@/lib/jobs/kernel'
import {
  processIdentifierAssignmentChunk, getIdentifierAssignmentJob,
  IDENTIFIER_ASSIGNMENT_JOBS,
} from '@/lib/identifiers/assignmentJob'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  // Ownership is proved from the STORED job, never from the request.
  const job = await getIdentifierAssignmentJob(jobId)
  if (!job || job.organizerUid !== scope.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const result = await processIdentifierAssignmentChunk(jobId)
  const after  = await getIdentifierAssignmentJob(jobId)
  return NextResponse.json(
    { ok: true, result, job: after ? serializeJob(after) : null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/** Cancels a run. Work already committed stays committed — see the result screen. */
export async function DELETE(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  const job = await getIdentifierAssignmentJob(jobId)
  if (!job || job.organizerUid !== scope.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const status = await cancelJob(IDENTIFIER_ASSIGNMENT_JOBS, jobId)
  const after = await getIdentifierAssignmentJob(jobId)
  return NextResponse.json({ ok: true, status, job: after ? serializeJob(after) : null })
}
