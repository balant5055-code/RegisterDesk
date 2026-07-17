// POST /api/organizer/events/[eventId]/registrations/bulk-jobs/[jobId]/process
//
// OE-1 — Drives ONE chunk of a bulk check-in/restore job (client poller; the
// registration-bulk cron also advances it). Resumes from the persisted cursor.
// Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { serializeJob }       from '@/lib/jobs/serialize'
import type { ProcessResult } from '@/lib/jobs/runner'
import {
  processRegistrationBulkChunk, REGISTRATION_BULK_JOBS, type RegistrationBulkJob,
} from '@/lib/registrations/bulkJob'
import type { SerializedBulkJob } from '../../route'

export type ProcessBulkJobResponse =
  | { success: true;  result: ProcessResult; job: SerializedBulkJob | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse<ProcessBulkJobResponse>> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationBulkJob>(REGISTRATION_BULK_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }

  const result = await processRegistrationBulkChunk(jobId)
  const after  = await getJob<RegistrationBulkJob>(REGISTRATION_BULK_JOBS, jobId)
  return NextResponse.json({ success: true, result, job: after ? serializeJob(after) : null })
}
