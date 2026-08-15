// POST /api/organizer/events/[eventId]/certificates/email-jobs/[jobId]/process
//
// Advances ONE chunk of a delivery job. The cron driver is the primary caller; this route
// exists so an operator can nudge a job without waiting for the next tick, and so the
// behaviour is testable through the same entry point the scheduler uses.
//
// It is NOT a browser driver: the UI polls GET for progress and never loops on this.
// If it did, the lease would arbitrate anyway — a second caller is skipped cheaply.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getEmailJob }               from '@/lib/certificates/emailJobsStore'
import { processEmailJobChunk }      from '@/lib/certificates/emailJobs'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { eventId, jobId } = await params
  const job = await getEmailJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const result = await processEmailJobChunk(jobId)
  const after  = await getEmailJob(jobId)

  return NextResponse.json({
    result,
    job: after ? {
      jobId:       after.jobId,
      status:      after.status,
      counts:      after.counts,
      needsReview: after.needsReview ?? 0,
      error:       after.error,
    } : null,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
