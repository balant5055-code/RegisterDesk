// GET /api/organizer/events/[eventId]/registrations/bulk-jobs/[jobId]
//
// OE-1 — Bulk check-in/restore job progress. Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { serializeJob }       from '@/lib/jobs/serialize'
import { REGISTRATION_BULK_JOBS, type RegistrationBulkJob } from '@/lib/registrations/bulkJob'
import type { SerializedBulkJob } from '../route'

export type GetBulkJobResponse =
  | { success: true;  job: SerializedBulkJob }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ eventId: string; jobId: string }> },
): Promise<NextResponse<GetBulkJobResponse>> {
  const { eventId, jobId } = await params
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const job = await getJob<RegistrationBulkJob>(REGISTRATION_BULK_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, job: serializeJob(job) }, { headers: { 'Cache-Control': 'no-store' } })
}
