// POST /api/organizer/events/[eventId]/certificates/jobs/[jobId]/cancel
//
// Requests cancellation of a bulk job. Already-generated certificates are kept;
// no further chunks will be processed. Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getJob, cancelJob }         from '@/lib/certificates/firestore'
import type { CertificateJob }       from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid }
}

export interface JobCancelResponse { status: CertificateJob['status'] }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  const job = await getJob(jobId)
  if (!job || job.organizerUid !== auth.uid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const status = await cancelJob(jobId)
  if (!status) return NextResponse.json({ error: 'Job not found' }, { status: 404 })

  return NextResponse.json({ status } satisfies JobCancelResponse)
}
