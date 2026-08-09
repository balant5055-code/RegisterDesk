// RD-BIB-01 · Link document shaping.
//
// PURE. No firebase-admin import — the same discipline as `features/ai/utils/jobDoc.ts`:
// importing the repository boots the Admin SDK, and a shape a privacy boundary depends on
// has to be testable directly.

import {
  BIB_SCHEMA_VERSION, EMPTY_BIB_SUMMARY,
  type BibDetectionSummary, type PhotoBibLinkDoc, type PhotoBibLinkView,
} from '@/features/bib-detection/types'
import type { MatchDecision } from '@/features/bib-detection/matching/matcher'

/**
 * ONE link per (photo, bib).
 *
 * Deterministic, so re-running detection on a photo overwrites its links instead of
 * accumulating a new set every time — the property that makes the whole pipeline safe to
 * retry. `assetId` is globally unique (`med_<24 hex>`) and `bibKey` is `[A-Z0-9]+`, so the
 * id can never contain a path separator or collide across tenants.
 */
export function linkId(assetId: string, bibKey: string): string {
  return `${assetId}__${bibKey}`
}

/** Everything about a link except the timestamps, which only the server can mint. */
export type PhotoBibLinkSeed =
  Omit<PhotoBibLinkDoc, 'detectedAt' | 'createdAt' | 'updatedAt' | 'reviewedAt'>

export interface BuildLinkInput {
  organizerUid: string
  eventId:      string
  eventSlug:    string
  assetId:      string
  galleryId:    string
  albumId:      string | null
  provider:        string
  modelVersion:    string | null
  pipelineVersion: number
  jobId:    string
  resultId: string
  decision: MatchDecision
}

/**
 * Builds one link from one decision.
 *
 * `reviewStatus` is always `pending` — a new detection is never born verified, however
 * confident the model was, and this function offers no way to say otherwise. A human
 * moves it, through a route that does not exist yet.
 */
export function buildLink(input: BuildLinkInput): PhotoBibLinkSeed {
  const { detection, matchStatus, candidates, snapshotVersion } = input.decision

  return {
    linkId:        linkId(input.assetId, detection.bibKey),
    schemaVersion: BIB_SCHEMA_VERSION,

    organizerUid: input.organizerUid,
    eventId:      input.eventId,
    eventSlug:    input.eventSlug,
    assetId:      input.assetId,
    galleryId:    input.galleryId,
    albumId:      input.albumId,

    bibNumber:   detection.bibNumber,
    bibKey:      detection.bibKey,
    confidence:  detection.confidence,
    boundingBox: detection.boundingBox,

    provider:        input.provider,
    modelVersion:    input.modelVersion,
    pipelineVersion: input.pipelineVersion,
    jobId:           input.jobId,
    resultId:        input.resultId,

    matchStatus,
    candidates,
    snapshotVersion,

    reviewStatus: 'pending',
    reviewedBy:   null,
  }
}

export function buildLinks(
  decisions: readonly MatchDecision[],
  common: Omit<BuildLinkInput, 'decision'>,
): PhotoBibLinkSeed[] {
  return decisions.map(decision => buildLink({ ...common, decision }))
}

// ─── Serialisation ────────────────────────────────────────────────────────────

function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  if (typeof v === 'string') return v
  return null
}

/**
 * The wire shape — ORGANIZER-ONLY.
 *
 * It drops `organizerUid`, `eventId` and `albumId`, and it carries no participant name,
 * time or rank: a link is a POINTER into the published snapshot, and anything about the
 * runner is read from there. That keeps this collection from becoming a second, drifting
 * copy of results, and keeps it free of personal data it has no reason to hold.
 */
export function serializeLink(doc: PhotoBibLinkDoc): PhotoBibLinkView {
  return {
    linkId:      doc.linkId,
    assetId:     doc.assetId,
    galleryId:   doc.galleryId,
    bibNumber:   doc.bibNumber,
    confidence:  doc.confidence,
    boundingBox: doc.boundingBox,
    provider:     doc.provider,
    modelVersion: doc.modelVersion,
    matchStatus:  doc.matchStatus,
    candidates:   doc.candidates,
    snapshotVersion: doc.snapshotVersion,
    reviewStatus: doc.reviewStatus,
    detectedAt:   toIso(doc.detectedAt),
  }
}

/** Folds per-field counts into the summary shape, ignoring anything unrecognised. */
export function toBibSummary(counts: Readonly<Record<string, number>>): BibDetectionSummary {
  const summary: BibDetectionSummary = { ...EMPTY_BIB_SUMMARY }
  const clean = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)

  for (const key of ['matched', 'unmatched', 'ambiguous'] as const) {
    summary[key]   = clean(counts[key] ?? 0)
    // `total` counts links, and every link has exactly one match status.
    summary.total += summary[key]
  }
  for (const key of ['pending', 'verified', 'rejected'] as const) {
    summary[key] = clean(counts[key] ?? 0)
  }

  return summary
}
