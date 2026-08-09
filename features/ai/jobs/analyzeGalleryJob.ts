// RD-AI-01 · Batch fan-out — SERVER ONLY.
//
// "Analyse every photo in this gallery" as a resumable batch.
//
// ═══ REUSE, NOT A SECOND JOB SYSTEM ═══════════════════════════════════════════
// This is a `lib/jobs` Job. Leasing, fencing, chunking, cursor resume, cancellation and the
// counts block all come from `lib/jobs/kernel.ts` + `runner.ts` — the same kernel the
// certificate and registration-import batches use. Nothing about batch control is
// re-implemented here; the only code below is the two strategy hooks that say WHAT to
// page over and WHAT to do per item.
//
// The per-item work is `enqueueAsset` — the batch creates AI jobs, it does not run them.
// Running is the dispatcher's job, on its own tick. Separating the two means a 40,000-photo
// gallery is enqueued in seconds and drained at whatever rate the provider tolerates.

import { createJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk, type JobPage, type JobStrategy, type ProcessResult } from '@/lib/jobs/runner'
import type { Job } from '@/lib/jobs/types'
import { listAssets } from '@/features/media-studio/repositories/assetRepo'
import { getOwnedGallery } from '@/features/media-studio/repositories/galleryRepo'
import type { MediaAssetDoc } from '@/features/media-studio/types'
import { AI_BATCHES, type AIJobKind } from '@/features/ai/types'
import { AIError } from '@/features/ai/types/errors'
import { resolveProvider } from '@/features/ai/providers'
import { enqueueAsset } from '@/features/ai/services/aiQueue'

/** aiBatches/{jobId} — a generic `lib/jobs` Job plus this batch's own payload. */
export interface AnalyzeGalleryJob extends Job {
  eventId:   string
  eventSlug: string
  galleryId: string
  kind:      AIJobKind
}

interface Ctx {
  eventId:   string
  eventSlug: string
  galleryId: string
  kind:      AIJobKind
}

const PAGE_SIZE = 200
const LEASE_MS  = 60_000

const strategy: JobStrategy<AnalyzeGalleryJob, Ctx, MediaAssetDoc> = {
  /**
   * Refuses the whole batch when nothing can serve the kind.
   *
   * A systemic failure, not a per-item one: enqueueing 40,000 jobs that can never run would
   * be worse than one clear "no provider is configured" on the batch.
   */
  async loadContext(job) {
    if (!resolveProvider(job.kind)) {
      return { ok: false, error: `No configured AI provider serves "${job.kind}".` }
    }
    const gallery = await getOwnedGallery(job.galleryId, job.organizerUid)
    if (!gallery) return { ok: false, error: 'Gallery not found.' }

    return {
      ok: true,
      ctx: {
        eventId:   gallery.eventId,
        eventSlug: gallery.eventSlug,
        galleryId: gallery.galleryId,
        kind:      job.kind,
      },
    }
  },

  async fetchPage(job, ctx, cursor, limit): Promise<JobPage<MediaAssetDoc>> {
    const page = await listAssets({
      organizerUid: job.organizerUid,
      galleryId:    ctx.galleryId,
      limit,
      cursor,
    })
    // Only a finished upload can be analysed; anything else is skipped silently rather than
    // counted as a failure, because it may still become ready.
    const items = page.assets.filter(a => a.status === 'ready')
    return { items, nextCursor: page.nextCursor, hasMore: page.nextCursor !== null }
  },

  async processItem(asset, job, ctx) {
    try {
      await enqueueAsset({
        organizerUid: job.organizerUid,
        eventId:      ctx.eventId,
        eventSlug:    ctx.eventSlug,
        assetId:      asset.assetId,
        galleryId:    asset.galleryId,
        albumId:      asset.albumId,
        kind:         ctx.kind,
        createdBy:    job.createdBy,
        batchId:      job.jobId,
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'Enqueue failed' }
    }
  },
}

export function batchId(galleryId: string, kind: AIJobKind): string {
  return `${galleryId}__${kind}`
}

/**
 * Creates the batch.
 *
 * The id is deterministic per (gallery, kind), so re-requesting the same analysis resumes or
 * reports the existing batch instead of starting a parallel one. `assetCount` on the gallery
 * seeds the progress denominator — it is maintained transactionally by Media Studio, so no
 * scan is needed to know the total.
 */
export async function createAnalyzeGalleryBatch(params: {
  organizerUid: string
  createdBy:    string
  galleryId:    string
  kind:         AIJobKind
}): Promise<AnalyzeGalleryJob> {
  if (!resolveProvider(params.kind)) {
    throw new AIError('NO_PROVIDER', `No configured AI provider serves "${params.kind}".`)
  }

  const gallery = await getOwnedGallery(params.galleryId, params.organizerUid)
  if (!gallery) throw new AIError('NOT_FOUND', 'Gallery not found.')

  const id       = batchId(params.galleryId, params.kind)
  const existing = await getJob<AnalyzeGalleryJob>(AI_BATCHES, id)
  if (existing && existing.status !== 'completed' && existing.status !== 'cancelled') {
    return existing
  }

  return createJob<AnalyzeGalleryJob>(AI_BATCHES, id, {
    organizerUid: params.organizerUid,
    createdBy:    params.createdBy,
    eventId:      gallery.eventId,
    eventSlug:    gallery.eventSlug,
    galleryId:    gallery.galleryId,
    kind:         params.kind,
  }, gallery.assetCount)
}

/** Advances one batch by a chunk. Safe to call repeatedly — it resumes from the cursor. */
export async function runAnalyzeGalleryChunk(
  jobId: string, budgetMs = 40_000,
): Promise<ProcessResult> {
  return runJobChunk<AnalyzeGalleryJob, Ctx, MediaAssetDoc>(jobId, strategy, {
    collection: AI_BATCHES,
    pageSize:   PAGE_SIZE,
    budgetMs,
    leaseMs:    LEASE_MS,
  })
}
