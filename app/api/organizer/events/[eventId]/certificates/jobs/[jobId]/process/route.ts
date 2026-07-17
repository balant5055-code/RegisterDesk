// POST /api/organizer/events/[eventId]/certificates/jobs/[jobId]/process
//
// Processes ONE chunk of a bulk job and returns progress + whether it's done.
// Call repeatedly (client poller or scheduled worker) until `done` is true —
// each call resumes from the persisted cursor, so an interrupted job continues
// rather than restarting. Security: auth + job ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getJob }                    from '@/lib/certificates/firestore'
import { loadEventContext, processJobChunk } from '@/lib/certificates/jobs'
import { serializeCertificateJob }   from '@/lib/certificates/types'
import type { SerializedCertificateJob } from '@/lib/certificates/types'
import type { ProcessResult }        from '@/lib/certificates/jobs'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

async function authUid(req: NextRequest): Promise<{ uid: string } | { error: NextResponse }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  return { uid: authz.workspaceUid }
}

export interface JobProcessResponse {
  result: ProcessResult
  job:    SerializedCertificateJob
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId, jobId } = await params
  const auth = await authUid(req)
  if ('error' in auth) return auth.error

  const job = await getJob(jobId)
  if (!job || job.organizerUid !== auth.uid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const ctx = await loadEventContext(auth.uid, eventId)
  if (!ctx.ok) {
    return ctx.code === 'not_found'
      ? NextResponse.json({ error: 'Event not found' }, { status: 404 })
      : NextResponse.json({ error: 'Event not published' }, { status: 422 })
  }

  const result = await processJobChunk(jobId, ctx.ctx)
  const after  = await getJob(jobId)

  return NextResponse.json({
    result,
    job: serializeCertificateJob(after ?? job),
  } satisfies JobProcessResponse)
}
