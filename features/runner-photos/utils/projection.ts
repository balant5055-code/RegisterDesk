// RD-RUNNER-01 · The public projection — THE security boundary.
//
// PURE. No SDK, no I/O. Deliberately outside the service, so what a stranger can be shown
// is provable by test rather than by reading a Firestore trace (the lesson from Sprint 4's
// `toPublicRace`).
//
// ═══ WHAT THIS FUNCTION GUARANTEES ════════════════════════════════════════════
// It CONSTRUCTS its output field by field and never spreads an input. A link carries
// `organizerUid`, `eventId`, `confidence`, `boundingBox`, `provider`, `reviewStatus` and
// `candidates`; an asset carries storage keys. None of it can reach a participant, because
// there is no path from those fields to the returned object.
// ══════════════════════════════════════════════════════════════════════════════

import type { PhotoBibLinkDoc } from '@/features/bib-detection/types'
import type { MediaAssetDoc, MediaRendition } from '@/features/media-studio/types'
import type { RunnerPhotoView } from '@/features/runner-photos/types'

/**
 * Which rendition a participant is shown.
 *
 * `medium` first — large enough to recognise yourself in, a fraction of the original's
 * bytes. The original is reserved for download.
 */
export const DISPLAY_RENDITION_PREFERENCE: readonly MediaRendition[] =
  ['medium', 'thumbnail', 'original']

/** Which rendition a download delivers: the best the organizer kept. */
export const DOWNLOAD_RENDITION_PREFERENCE: readonly MediaRendition[] =
  ['original', 'medium', 'thumbnail']

/**
 * Whether a link may be shown to the runner who holds its bib.
 *
 * ═══ APPROVED ONLY ═══════════════════════════════════════════════════════════
 * A participant receives a photograph only after a HUMAN has approved the match.
 * `reviewStatus` must be exactly `verified`; `pending` and `rejected` are both withheld.
 *
 * This is an architecture-review decision (Sprint 10 feedback) and it is deliberately
 * ALLOW-LIST shaped rather than deny-list shaped. A deny-list — "hide rejected" — silently
 * admits every future status anyone adds, and admits `pending`, which is a machine's
 * unreviewed guess about which human is in a photograph. Getting that wrong shows one
 * runner another runner's picture, and there is no undo for having shown it.
 *
 * The cost is stated plainly rather than hidden: with no review UI yet (RD-BIB-01, out of
 * scope by instruction), NOTHING is approved, so every gallery is empty. That is the correct
 * behaviour for a pipeline whose output no human has checked. See
 * docs/RD-RUNNER-PHOTO-GALLERY.md § Known limitations.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Two further refusals, each for its own reason:
 *
 *   • `matchStatus !== 'matched'` — an AMBIGUOUS link means two races in this event both
 *     have a runner with that bib and the pipeline refused to guess (RD-BIB-01). Showing it
 *     to every candidate would hand a runner a stranger's photograph, which is the exact
 *     failure the ambiguity rule exists to prevent. `unmatched` has no runner at all.
 *
 *   • schema version — a document written by a future shape is not interpreted by guesswork.
 */
export function isVisibleLink(link: PhotoBibLinkDoc, schemaVersion: number): boolean {
  if (link.schemaVersion !== schemaVersion) return false
  if (link.matchStatus !== 'matched') return false
  // Allow-list, not deny-list. Anything that is not an explicit human approval is withheld.
  if (link.reviewStatus !== 'verified') return false
  return true
}

/**
 * Whether the asset behind a link may be served.
 *
 * The link and the asset are separate documents, so they are cross-checked rather than
 * trusted: an asset whose tenant or event disagrees with the link is a data fault, and a
 * data fault must not become a disclosure.
 */
export function isServableAsset(
  asset: MediaAssetDoc | undefined, link: PhotoBibLinkDoc, schemaVersion: number,
): asset is MediaAssetDoc {
  if (!asset) return false                              // deleted, or never existed
  if (asset.schemaVersion !== schemaVersion) return false
  if (asset.status !== 'ready') return false            // pending, failed, or soft-deleted
  if (asset.visibility === 'PRIVATE') return false      // the organizer withheld it
  if (asset.organizerUid !== link.organizerUid) return false
  if (asset.eventSlug !== link.eventSlug) return false
  return true
}

/** The first rendition present, in preference order. */
export function pickRendition(
  asset: MediaAssetDoc, preference: readonly MediaRendition[],
): { rendition: MediaRendition; path: string } | null {
  for (const rendition of preference) {
    const record = asset.renditions[rendition]
    if (record?.path) return { rendition, path: record.path }
  }
  return null
}

/** Firestore Timestamp | Date | ISO string → ISO string. Anything else → null. */
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object' && typeof (v as { toDate?: unknown }).toDate === 'function') {
    try { return (v as { toDate(): Date }).toDate().toISOString() } catch { return null }
  }
  if (typeof v === 'string') return v
  return null
}

export interface ProjectionInput {
  link:  PhotoBibLinkDoc
  asset: MediaAssetDoc
  /** Resolved by the caller from a single batched read — never a per-photo lookup. */
  galleryName: string
  /** Short-lived signed URL for the display rendition. */
  thumbnailUrl: string
  /** Our own download route for this photo. */
  downloadUrl:  string
}

/**
 * Builds what the participant receives.
 *
 * Dimensions come from the ORIGINAL where recorded, because that is what a download will be;
 * falling back to the display rendition would tell a participant the wrong thing about the
 * file they are about to save.
 */
export function toRunnerPhoto(input: ProjectionInput): RunnerPhotoView {
  const { link, asset } = input

  return {
    photoId:     link.linkId,
    galleryName: input.galleryName,
    // Always null: the browser-side re-encode in Media Studio discards EXIF, so the platform
    // has never held a capture time. Never substitute the upload time for it.
    capturedAt:  null,
    uploadedAt:  toIso(asset.uploadedAt),
    width:       asset.width,
    height:      asset.height,
    thumbnailUrl: input.thumbnailUrl,
    downloadUrl:  input.downloadUrl,
  }
}

/**
 * Fallback gallery name.
 *
 * A gallery deleted after its photos were linked leaves the asset intact, and a participant
 * should still see the photo — under a neutral label rather than an empty heading.
 */
export const UNKNOWN_GALLERY_NAME = 'Race photos'
