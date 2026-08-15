// GET /api/organizer/events/[eventId]/certificates/email-jobs/[jobId]
//
// Polls one bulk delivery job. This is how the Recipients tab shows progress, and it is a
// READ — the browser never advances the job. Progress therefore survives a closed tab, a
// refresh and a navigation, because it lives on the job document, not in React state.
//
// `pending` is derived (total − processed) rather than stored: two fields that must agree
// are two fields that can disagree.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getEmailJob }               from '@/lib/certificates/emailJobsStore'
import { serializeCertificateEmailJob } from '@/lib/certificates/types'
import type { SerializedCertificateEmailJob } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export interface EmailJobResponse {
  job:     SerializedCertificateEmailJob
  pending: number
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { eventId, jobId } = await params
  const job = await getEmailJob(jobId)
  // Ownership is re-checked against the JOB document, so a job id cannot be replayed
  // against another workspace's event.
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const total     = job.counts?.total ?? 0
  const processed = job.counts?.processed ?? 0

  return NextResponse.json({
    job:     serializeCertificateEmailJob(job),
    pending: Math.max(0, total - processed),
  } satisfies EmailJobResponse, { headers: { 'Cache-Control': 'no-store' } })
}
