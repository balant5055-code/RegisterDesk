// POST /api/organizer/media-studio/jobs   — start a bulk operation
// GET  /api/organizer/media-studio/jobs?galleryId=  — its progress
//
// RD-MEDIA-04. Bulk delete / move / publish over a gallery or one of its albums.
//
// The route only VALIDATES and ENQUEUES. Draining is `/api/cron/media-jobs`, because a
// gallery holds tens of thousands of photos and the work is minutes long — far past any
// serverless request budget. Everything about batch control (leasing, chunking, cursor
// resume, cancellation, counts) comes from `lib/jobs`; none of it is re-implemented.

import { NextRequest, NextResponse } from 'next/server'
import { serializeJob, type SerializedJob } from '@/lib/jobs/serialize'
import { cancelJob, getJob } from '@/lib/jobs/kernel'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import { createBulkJob, bulkJobId, type MediaBulkJob } from '@/features/media-studio/jobs/bulkAssetJob'
import {
  MEDIA_JOBS, MEDIA_BULK_ACTIONS, isAssignableVisibility, isMediaBulkAction,
} from '@/features/media-studio/types'

export interface BulkJobResponse { job: SerializedJob<MediaBulkJob> }
export interface BulkJobListResponse { jobs: SerializedJob<MediaBulkJob>[] }

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const action = raw.action
  if (!isMediaBulkAction(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${MEDIA_BULK_ACTIONS.join(', ')}` },
      { status: 400 },
    )
  }

  const galleryId = str(raw.galleryId)
  if (!galleryId) return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })

  const visibility = raw.visibility
  if (action === 'visibility' && !isAssignableVisibility(visibility)) {
    return NextResponse.json(
      { error: 'visibility must be PUBLIC, PRIVATE or SIGNED_URL.' },
      { status: 400 },
    )
  }

  // Ownership of every id is re-checked inside `createBulkJob`, against the workspace —
  // this route never trusts a caller-supplied gallery or album.
  const outcome = await createBulkJob({
    organizerUid: authz.workspaceUid,
    createdBy:    authz.callerUid,
    action,
    galleryId,
    albumId:      str(raw.albumId) || null,
    toGalleryId:  str(raw.toGalleryId) || null,
    toAlbumId:    str(raw.toAlbumId) || null,
    visibility:   isAssignableVisibility(visibility) ? visibility : null,
  })

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  }

  const body: BulkJobResponse = { job: serializeJob(outcome.job) }
  return NextResponse.json(body, { status: 202, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const params    = req.nextUrl.searchParams
  const galleryId = params.get('galleryId')?.trim() ?? ''
  if (!galleryId) return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })

  const albumId = params.get('albumId')?.trim() || null

  // Job ids are deterministic per (gallery, album, action), so the whole set is addressable
  // without a query — and therefore without an index or a scan.
  const jobs = await Promise.all(
    MEDIA_BULK_ACTIONS.map(action => getJob<MediaBulkJob>(MEDIA_JOBS, bulkJobId(galleryId, albumId, action))),
  )

  const body: BulkJobListResponse = {
    jobs: jobs
      .filter((j): j is MediaBulkJob => j !== null && j.organizerUid === authz.workspaceUid)
      .map(serializeJob),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const jobId = req.nextUrl.searchParams.get('jobId')?.trim() ?? ''
  if (!jobId) return NextResponse.json({ error: 'jobId is required' }, { status: 400 })

  const job = await getJob<MediaBulkJob>(MEDIA_JOBS, jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  // Cancellation is cooperative and observed at the next chunk commit — work already
  // committed stands, which is correct: a half-deleted gallery is deleted that far.
  const status = await cancelJob(MEDIA_JOBS, jobId)
  return NextResponse.json({ status }, { headers: { 'Cache-Control': 'no-store' } })
}
