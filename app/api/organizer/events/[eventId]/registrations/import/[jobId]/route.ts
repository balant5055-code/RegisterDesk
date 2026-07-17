// GET /api/organizer/events/[eventId]/registrations/import/[jobId]
//
// RM-2.3A — Returns a registration-import job (status, counts, cursor, summary).
// Security: auth + the job must belong to the caller's workspace and this event.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { serializeJob }       from '@/lib/jobs/serialize'
import { REGISTRATION_IMPORT_JOBS, type RegistrationImportJob } from '@/lib/registrations/importJob'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationImportJob>(REGISTRATION_IMPORT_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json({ job: serializeJob(job) })
}
