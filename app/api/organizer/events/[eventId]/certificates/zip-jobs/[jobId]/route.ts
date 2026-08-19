// GET /api/organizer/events/[eventId]/certificates/zip-jobs/[jobId]
//
// Poll a bulk-ZIP job. While it runs this reports progress; once complete it returns a
// short-lived signed URL per shard plus the manifest.
//
// The response is deliberately EXPLICIT about completeness: `requested`, `included` and
// `failedIds` are all present, so a caller can never mistake a short archive for a full
// one. That is the property the old synchronous route lost when it sliced a selection to
// 5,000 and mentioned it only in a response header.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getZipJob }                 from '@/lib/certificates/zipJobsStore'
import { sortShards }                from '@/lib/certificates/zipJobs'
import { storage }                   from '@/features/platform-storage'
import { ARTIFACT_SIGNED_URL_TTL_S } from '@/lib/certificates/constants'

type Params = { params: Promise<{ eventId: string; jobId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { eventId, jobId } = await params
  const job = await getZipJob(jobId)
  // Ownership is re-checked against the job document, so a job id cannot be replayed
  // against another workspace's event.
  if (!job || job.organizerUid !== authz.workspaceUid || job.eventId !== eventId) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const included = (job.shards ?? []).reduce((n, s) => n + s.count, 0)
  // Exact, and never the truncated sample: `failedIds` on the document stops growing at
  // ZIP_FAILED_SAMPLE_MAX so it stays writable at 50k, while `failedCount` keeps counting.
  const failedCount = job.failedCount ?? (job.failedIds ?? []).length
  // Set by the finalize seal, which is the only path to status 'completed'. A completed job
  // without it predates multipart verification and is reported as such rather than as whole.
  const outcome = job.outcome ?? (job.status === 'completed' ? 'unverified' : null)

  // Signed URLs are minted ONLY here, after the ownership check above, and only for a
  // finished job — never stored on the document, because they expire.
  //
  // Shards are sorted by their STORAGE identity (the cursor offset) and the user-facing
  // "part N" is derived from that ordering. The ordinal is presentation only: it is never
  // persisted and never used to address an object, which is precisely the mistake that let
  // several shards in one chunk collide on a single key.
  const parts = job.status === 'completed'
    ? await Promise.all(sortShards(job.shards ?? []).map(async (s, i) => ({
        part:  i + 1,
        count: s.count,
        bytes: s.bytes,
        url:   await storage.generateSignedUrl({
          path: s.key, operation: 'read', expiresIn: ARTIFACT_SIGNED_URL_TTL_S,
          responseContentDisposition:
            `attachment; filename="certificates-${eventId}-part-${String(i + 1).padStart(4, '0')}.zip"`,
        }),
      })))
    : []

  return NextResponse.json({
    jobId:     job.jobId,
    status:    job.status,
    scope:     job.scope,
    counts:    job.counts,
    requested: job.counts?.total ?? 0,
    included,
      // 'complete' | 'partial' | 'unverified' | null. A caller must read THIS, not `status`,
      // to decide whether the export is whole: 'completed' only means the job stopped running.
      outcome,
      // Exact, unlike `failedIds`, which is a bounded display sample so the document stays
      // writable at 50k. The complete per-part lists are in the manifest.
      failedCount,
      failedIds: job.failedIds ?? [],
      partCount: (job.shards ?? []).length,
    parts,
    manifestUrl: job.manifestKey
      ? await storage.generateSignedUrl({ path: job.manifestKey, operation: 'read', expiresIn: ARTIFACT_SIGNED_URL_TTL_S })
      : null,
    error: job.error,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
