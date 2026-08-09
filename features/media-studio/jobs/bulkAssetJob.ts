// RD-MEDIA-04 · Bulk operations — SERVER ONLY.
//
// "Delete every photo in this gallery", "move this album into that gallery", "publish these
// 40,000 photos" — as a resumable batch.
//
// ═══ REUSE, NOT A SECOND JOB SYSTEM ═══════════════════════════════════════════
// This is a `lib/jobs` Job. Leasing, fencing, chunking, cursor resume, cancellation and the
// counts block all come from `lib/jobs/kernel.ts` + `runner.ts` — the same kernel the
// certificate, registration-import and AI batches use. The only code below is the two
// strategy hooks that say WHAT to page over and WHAT to do per item.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── Why bulk cannot be a loop in a route ────────────────────────────────────
// A gallery holds tens of thousands of photos. Deleting them means one Firestore
// transaction and up to three object deletions EACH — minutes of work, far past any
// serverless request budget, and a half-finished sweep with no cursor would be
// unrecoverable. The kernel already solves exactly this, so nothing here re-solves it.

import { createJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk, type JobPage, type JobStrategy, type ProcessResult } from '@/lib/jobs/runner'
import type { Job } from '@/lib/jobs/types'
import {
  MEDIA_JOBS, type AssignableVisibility, type MediaAssetDoc, type MediaBulkAction,
} from '@/features/media-studio/types'
import {
  listAssets, markAssetDeleted, moveAsset, setAssetVisibility,
} from '@/features/media-studio/repositories/assetRepo'
import { getOwnedAlbum, getOwnedGallery } from '@/features/media-studio/repositories/galleryRepo'
import { removeObjects } from '@/features/media-studio/services/uploadService'
// PURE — kept out of this file so a route or a test can read the id rule without booting
// the Admin SDK.
import { bulkJobId } from '@/features/media-studio/utils/bulkOps'

export { bulkJobId }

/** mediaJobs/{jobId} — a generic `lib/jobs` Job plus this batch's own payload. */
export interface MediaBulkJob extends Job {
  action:      MediaBulkAction
  eventId:     string
  /** Scope: every ready photo in this gallery, optionally narrowed to one album. */
  galleryId:   string
  albumId:     string | null
  /** `move` only. */
  toGalleryId: string | null
  toAlbumId:   string | null
  /** `visibility` only. */
  visibility:  AssignableVisibility | null
}

interface Ctx {
  organizerUid: string
  action:       MediaBulkAction
  toGalleryId:  string | null
  toAlbumId:    string | null
  visibility:   AssignableVisibility | null
}

const PAGE_SIZE = 100
const LEASE_MS  = 60_000

const strategy: JobStrategy<MediaBulkJob, Ctx, MediaAssetDoc> = {
  /**
   * Re-validates the whole operation on EVERY chunk, not just at creation.
   *
   * A batch can run for many minutes across several ticks. A destination gallery deleted
   * halfway through would otherwise move the remaining photos into nothing.
   */
  async loadContext(job) {
    const gallery = await getOwnedGallery(job.galleryId, job.organizerUid)
    if (!gallery) return { ok: false, error: 'Gallery not found.' }

    if (job.action === 'move') {
      if (!job.toGalleryId) return { ok: false, error: 'A move needs a destination gallery.' }
      const dest = await getOwnedGallery(job.toGalleryId, job.organizerUid)
      if (!dest) return { ok: false, error: 'Destination gallery not found.' }
      if (dest.eventId !== gallery.eventId) {
        return { ok: false, error: 'Photos can only be moved within their own event.' }
      }
      if (job.toAlbumId) {
        const album = await getOwnedAlbum(job.toAlbumId, job.organizerUid)
        if (!album || album.galleryId !== job.toGalleryId) {
          return { ok: false, error: 'Destination album is not in that gallery.' }
        }
      }
    }

    if (job.action === 'visibility' && !job.visibility) {
      return { ok: false, error: 'A visibility change needs a target visibility.' }
    }

    return {
      ok: true,
      ctx: {
        organizerUid: job.organizerUid,
        action:       job.action,
        toGalleryId:  job.toGalleryId,
        toAlbumId:    job.toAlbumId,
        visibility:   job.visibility,
      },
    }
  },

  /**
   * Pages over the SOURCE gallery.
   *
   * A `move` and a `delete` both empty the page they just processed, so the cursor is NOT
   * advanced for them — the next page is read from the start of what remains. Advancing a
   * cursor past documents that have left the query is how a bulk operation silently skips
   * half its scope.
   */
  async fetchPage(job, ctx, cursor, limit): Promise<JobPage<MediaAssetDoc>> {
    const drains = ctx.action === 'delete' || ctx.action === 'move'

    const page = await listAssets({
      organizerUid: job.organizerUid,
      galleryId:    job.galleryId,
      albumId:      job.albumId,
      limit,
      cursor:       drains ? null : cursor,
    })

    const items = page.assets.filter(a => a.status === 'ready')

    if (drains) {
      // More work remains exactly while this page returned anything.
      return { items, nextCursor: null, hasMore: items.length > 0 }
    }
    return { items, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null }
  },

  /** One photo. A per-item failure is counted and never fails the batch. */
  async processItem(asset, job, ctx) {
    try {
      if (ctx.action === 'delete') {
        const outcome = await markAssetDeleted(asset.assetId)
        if (!outcome.ok) return { ok: false, error: 'Photo not found' }
        // Best-effort, exactly as the single-photo route does. A failure here leaves an
        // orphaned object, which the reclamation sweep picks up — the record is already
        // marked `deleted` and keeps its paths.
        await removeObjects(outcome.paths)
        return { ok: true }
      }

      if (ctx.action === 'move') {
        const outcome = await moveAsset({
          assetId:      asset.assetId,
          organizerUid: ctx.organizerUid,
          toGalleryId:  ctx.toGalleryId as string,
          toAlbumId:    ctx.toAlbumId,
        })
        return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
      }

      const outcome = await setAssetVisibility({
        assetId:      asset.assetId,
        organizerUid: ctx.organizerUid,
        visibility:   ctx.visibility as AssignableVisibility,
      })
      return outcome.ok ? { ok: true } : { ok: false, error: outcome.error }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'Failed' }
    }
  },
}

export interface CreateBulkJobInput {
  organizerUid: string
  createdBy:    string
  action:       MediaBulkAction
  galleryId:    string
  albumId:      string | null
  toGalleryId?: string | null
  toAlbumId?:   string | null
  visibility?:  AssignableVisibility | null
}

export type CreateBulkOutcome =
  | { ok: true;  job: MediaBulkJob }
  | { ok: false; status: number; error: string }

/**
 * Creates the batch.
 *
 * The id is deterministic per (gallery, album, action), so double-clicking "Delete all"
 * resumes the existing batch instead of starting a second one racing the first. A completed
 * or cancelled batch with the same id is replaced, because the operation can legitimately be
 * run again later.
 */
export async function createBulkJob(input: CreateBulkJobInput): Promise<CreateBulkOutcome> {
  const gallery = await getOwnedGallery(input.galleryId, input.organizerUid)
  if (!gallery) return { ok: false, status: 404, error: 'Gallery not found' }

  if (input.albumId) {
    const album = await getOwnedAlbum(input.albumId, input.organizerUid)
    if (!album || album.galleryId !== input.galleryId) {
      return { ok: false, status: 404, error: 'Album not found in this gallery' }
    }
  }

  if (input.action === 'move') {
    if (!input.toGalleryId) {
      return { ok: false, status: 400, error: 'A move needs a destination gallery.' }
    }
    const dest = await getOwnedGallery(input.toGalleryId, input.organizerUid)
    if (!dest) return { ok: false, status: 404, error: 'Destination gallery not found' }
    if (dest.eventId !== gallery.eventId) {
      return { ok: false, status: 409, error: 'Photos can only be moved within their own event.' }
    }
    if (input.toGalleryId === input.galleryId && (input.toAlbumId ?? null) === input.albumId) {
      return { ok: false, status: 400, error: 'Those photos are already there.' }
    }
  }

  if (input.action === 'visibility' && !input.visibility) {
    return { ok: false, status: 400, error: 'A visibility change needs a target visibility.' }
  }

  const jobId = bulkJobId(input.galleryId, input.albumId, input.action)
  const existing = await getJob<MediaBulkJob>(MEDIA_JOBS, jobId)
  if (existing && existing.status !== 'completed' && existing.status !== 'cancelled') {
    return { ok: true, job: existing }
  }

  // `assetCount` is maintained transactionally by every asset write, so the denominator
  // needs no scan. An album-scoped job uses the album's own counter.
  const total = input.albumId
    ? (await getOwnedAlbum(input.albumId, input.organizerUid))?.assetCount ?? 0
    : gallery.assetCount

  const job = await createJob<MediaBulkJob>(MEDIA_JOBS, jobId, {
    organizerUid: input.organizerUid,
    createdBy:    input.createdBy,
    action:       input.action,
    eventId:      gallery.eventId,
    galleryId:    input.galleryId,
    albumId:      input.albumId,
    toGalleryId:  input.toGalleryId ?? null,
    toAlbumId:    input.toAlbumId ?? null,
    visibility:   input.visibility ?? null,
  }, total)

  return { ok: true, job }
}

/** Advances one batch by a chunk. Safe to call repeatedly — it resumes. */
export async function runBulkChunk(jobId: string, budgetMs = 40_000): Promise<ProcessResult> {
  return runJobChunk<MediaBulkJob, Ctx, MediaAssetDoc>(jobId, strategy, {
    collection: MEDIA_JOBS,
    pageSize:   PAGE_SIZE,
    budgetMs,
    leaseMs:    LEASE_MS,
  })
}
