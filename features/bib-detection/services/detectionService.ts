// RD-BIB-01 · The capability — SERVER ONLY.
//
// What turns a stored AI result into a photo ↔ runner link. This is the ONLY consumer the
// pipeline registers, and it is registered in one assembly file (`features/ai/bootstrap.ts`)
// so the generic dispatcher never learns the word "bib".
//
// Everything here is IDEMPOTENT. The dispatcher runs it after a job is already committed, so
// a re-run is a normal recovery path, not an exception: parsing is pure, matching is a read,
// and the write replaces a photo's links rather than appending to them.

import {
  aiJobId, aiResultId, createAnalyzeGalleryBatch, getJobView,
  type AIResultContext, type AnalyzeGalleryJob,
} from '@/features/ai'
import { getOwnedJob } from '@/features/ai/repositories/aiJobRepo'
import { getOwnedResult } from '@/features/ai/repositories/aiResultRepo'
import { AIError } from '@/features/ai/types/errors'
import { BIB_DETECT_KIND, type BibDetectionSummary } from '@/features/bib-detection/types'
import { parseDetectionPayload } from '@/features/bib-detection/utils/payload'
import { matchDetections } from '@/features/bib-detection/services/matchService'
import { buildLinks } from '@/features/bib-detection/utils/linkDoc'
import {
  replaceLinksForAsset, summariseForEvent,
} from '@/features/bib-detection/repositories/photoBibLinkRepo'

export interface DetectionOutcome {
  assetId:      string
  detections:   number
  matched:      number
  unmatched:    number
  ambiguous:    number
  linksWritten: number
  linksRemoved: number
  /** Provider entries that were not usable — malformed, or not a plausible bib. */
  discarded:    number
  /** Detections dropped by the per-photo cap. Reported so a truncation is never silent. */
  truncated:    number
  /** Repeat reads of one bib in a single frame, folded into one link. */
  deduplicated: number
}

/**
 * The registered consumer: AI result → links.
 *
 * A photo with no detections still runs to completion and still writes — with an empty seed
 * list, which DELETES any links a previous run left behind. "The model now sees nothing
 * here" is a real answer and has to be able to overwrite an earlier one.
 */
export async function consumeBibDetectionResult(ctx: AIResultContext): Promise<DetectionOutcome> {
  const { job, result } = ctx

  const parsed = parseDetectionPayload(result.payload)
  const decisions = await matchDetections(job.eventSlug, parsed.payload.detections)

  const seeds = buildLinks(decisions, {
    organizerUid: job.organizerUid,
    eventId:      job.eventId,
    eventSlug:    job.eventSlug,
    assetId:      job.assetId,
    galleryId:    job.galleryId,
    albumId:      job.albumId,
    provider:        result.providerId,
    modelVersion:    result.providerVersion,
    pipelineVersion: result.pipelineVersion,
    jobId:    job.jobId,
    resultId: result.resultId,
  })

  const written = await replaceLinksForAsset(job.assetId, seeds)

  return {
    assetId:      job.assetId,
    detections:   parsed.payload.detections.length,
    matched:      decisions.filter(d => d.matchStatus === 'matched').length,
    unmatched:    decisions.filter(d => d.matchStatus === 'unmatched').length,
    ambiguous:    decisions.filter(d => d.matchStatus === 'ambiguous').length,
    linksWritten: written.written,
    linksRemoved: written.removed,
    discarded:    parsed.discarded,
    truncated:    parsed.truncated,
    deduplicated: parsed.deduplicated,
  }
}

/**
 * Re-runs MATCHING for one photo against the current published results, without re-running
 * detection.
 *
 * Two reasons this exists. A re-publish bumps the snapshot version, which makes every link
 * decided against the old one stale. And the consumer is fail-soft, so a matching failure
 * leaves a stored result with no links; this is how that is repaired.
 *
 * It costs no inference: the provider is never called, only the result it already produced
 * is read.
 */
export async function rematchAsset(
  assetId: string, organizerUid: string,
): Promise<DetectionOutcome> {
  const jobId = aiJobId(assetId, BIB_DETECT_KIND)

  const job = await getOwnedJob(jobId, organizerUid)
  if (!job) throw new AIError('NOT_FOUND', 'This photo has not been analysed for bib numbers.')

  const result = await getOwnedResult(aiResultId(jobId), organizerUid)
  if (!result) throw new AIError('NOT_FOUND', 'No stored detection result for this photo.')

  return consumeBibDetectionResult({ job, result })
}

// ─── Starting a run ───────────────────────────────────────────────────────────

/**
 * Queues bib detection for every ready photo in a gallery.
 *
 * A thin wrapper over the Sprint 8 batch: the fan-out, the leasing, the cursor resume and
 * the cancellation are all `lib/jobs`, and this only supplies the kind. It will refuse with
 * `NO_PROVIDER` until a bib-detection provider is registered and configured.
 */
export async function startBibDetection(params: {
  galleryId:    string
  organizerUid: string
  createdBy:    string
}): Promise<AnalyzeGalleryJob> {
  return createAnalyzeGalleryBatch({
    galleryId:    params.galleryId,
    organizerUid: params.organizerUid,
    createdBy:    params.createdBy,
    kind:         BIB_DETECT_KIND,
  })
}

/** The per-photo job's current state, for a caller that wants to poll one asset. */
export async function getDetectionJob(assetId: string, organizerUid: string) {
  return getJobView(aiJobId(assetId, BIB_DETECT_KIND), organizerUid)
}

export async function summarise(
  organizerUid: string, eventId: string,
): Promise<BibDetectionSummary> {
  return summariseForEvent(organizerUid, eventId)
}
