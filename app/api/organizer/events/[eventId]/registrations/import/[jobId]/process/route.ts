// POST /api/organizer/events/[eventId]/registrations/import/[jobId]/process
//
// RM-2.3A — Processes ONE chunk of a registration-import job and returns progress
// + whether it's done. Call repeatedly (client poller or the scheduled cron) until
// `done` is true — each call resumes from the persisted cursor. Delegates entirely
// to the generic runner via processRegistrationImportChunk. Security: auth + job
// ownership. No registration logic lives here.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { serializeJob }       from '@/lib/jobs/serialize'
import {
  processRegistrationImportChunk, REGISTRATION_IMPORT_JOBS, type RegistrationImportJob,
} from '@/lib/registrations/importJob'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationImportJob>(REGISTRATION_IMPORT_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const result = await processRegistrationImportChunk(jobId)
  const after  = await getJob<RegistrationImportJob>(REGISTRATION_IMPORT_JOBS, jobId)

  return NextResponse.json({ result, job: serializeJob(after ?? job) })
}
