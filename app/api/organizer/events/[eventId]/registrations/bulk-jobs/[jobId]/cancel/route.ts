// POST /api/organizer/events/[eventId]/registrations/bulk-jobs/[jobId]/cancel
//
// OE-1 — Requests cancellation of a bulk check-in/restore job. Already-processed
// registrations are kept; no further chunks run. Reuses the generic kernel
// cancelJob(). Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob, cancelJob }  from '@/lib/jobs/kernel'
import { REGISTRATION_BULK_JOBS, type RegistrationBulkJob } from '@/lib/registrations/bulkJob'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationBulkJob>(REGISTRATION_BULK_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const status = await cancelJob(REGISTRATION_BULK_JOBS, jobId)
  if (!status) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  return NextResponse.json({ success: true, status })
}
