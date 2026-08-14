// POST /api/organizer/events/[eventId]/certificates/zip-jobs/[jobId]/process
//
// Processes ONE chunk (one shard) of a bulk-ZIP job and returns progress. Mirrors the
// certificate generation job's /process endpoint exactly: call repeatedly until `done`,
// each call resuming from the persisted cursor. The cron driver uses the same entry point,
// so a browser tab and a scheduled tick can never both advance the job — the lease
// arbitrates and the loser is skipped cheaply.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getZipJob }                 from '@/lib/certificates/zipJobsStore'
import { processZipJobChunk }        from '@/lib/certificates/zipJobs'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export const dynamic     = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { eventId, jobId } = await params
  const job = await getZipJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const result = await processZipJobChunk(jobId)
  const after  = await getZipJob(jobId)

  return NextResponse.json({
    result,
    job: after
      ? { jobId: after.jobId, status: after.status, counts: after.counts, shards: after.shards?.length ?? 0, error: after.error }
      : null,
  })
}
