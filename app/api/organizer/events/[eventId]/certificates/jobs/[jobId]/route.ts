// GET /api/organizer/events/[eventId]/certificates/jobs/[jobId] — job status
//
// Security: auth + the job must belong to the caller and this event.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getJob }                    from '@/lib/certificates/firestore'
import { serializeCertificateJob }   from '@/lib/certificates/types'
import type { SerializedCertificateJob } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid }
}

export interface JobStatusResponse { job: SerializedCertificateJob }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  const job = await getJob(jobId)
  if (!job || job.organizerUid !== auth.uid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  return NextResponse.json({ job: serializeCertificateJob(job) } satisfies JobStatusResponse)
}
