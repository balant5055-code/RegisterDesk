// POST /api/organizer/events/[eventId]/registrations/import/[jobId]/cancel
//
// RM-2.3A — Requests cancellation of a registration-import job. Already-created
// registrations are kept; no further chunks are processed. Reuses the generic
// kernel cancelJob(). Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import { getJob, cancelJob }   from '@/lib/jobs/kernel'
import { REGISTRATION_IMPORT_JOBS, type RegistrationImportJob } from '@/lib/registrations/importJob'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationImportJob>(REGISTRATION_IMPORT_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const status = await cancelJob(REGISTRATION_IMPORT_JOBS, jobId)
  if (!status) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  return NextResponse.json({ status })
}
