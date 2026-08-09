// RD-MEDIA-01 · Duplicate detection.
//
// PURE. No SDK, no I/O.
//
// Detection is CHECKSUM-based: the sha256 of the ORIGINAL source bytes, computed before any
// compression. Hashing the compressed output instead would be worthless — re-encoding the
// same photo under a different profile produces different bytes, so the same photo would
// stop matching itself.
//
// Filename is never used. Two cameras both writing `DSC_0001.jpg` are two different photos;
// the same photo copied out of two folders is one.

export type DuplicateResolution = 'skip' | 'replace' | 'keep-both'

export const DUPLICATE_RESOLUTIONS: readonly DuplicateResolution[] =
  ['skip', 'replace', 'keep-both']

export const DEFAULT_DUPLICATE_RESOLUTION: DuplicateResolution = 'skip'

export interface DuplicateCandidate {
  /** Client-side id for the queued item. */
  itemId:   string
  checksum: string
}

export interface ExistingAssetRef {
  assetId:   string
  checksum:  string
  galleryId: string
  albumId:   string | null
  /**
   * MS-FINAL-01 · Enough for an organizer to recognise the photo they already uploaded.
   *
   * A gallery id alone answers 'where' but not 'which' — 'IMG_4821.jpg, 3 March' is what
   * makes the match believable. Both are read from the asset document the query already
   * fetches: no extra read, no new field, no index change.
   *
   * Deliberately NOT a thumbnail. A preview would need a signed URL per match, and this
   * module's rule is that a media surface never calls storage.resolveUrl directly — that is
   * a resolution path of its own, not a wiring change.
   */
  originalFilename: string | null
  /** Epoch ms. 0 when the stored timestamp is unreadable. */
  uploadedAtMs:     number
}

export interface DuplicateMatch {
  itemId:   string
  checksum: string
  existing: ExistingAssetRef
}

export interface DuplicateScan {
  /** Items matching something already stored. */
  matches: DuplicateMatch[]
  /** Items that are new. */
  fresh:   DuplicateCandidate[]
  /**
   * Items duplicated WITHIN this batch (the organizer selected the same photo twice, or a
   * folder contains a copy). The first occurrence is treated as fresh; the rest are
   * reported here so nothing is uploaded twice in one run.
   */
  intraBatch: DuplicateMatch[]
}

/**
 * Splits a batch against what already exists.
 *
 * Both directions matter, and missing the second is a classic bulk-upload bug: a folder of
 * 5,000 photos containing 40 accidental copies would otherwise upload all 40.
 */
export function scanForDuplicates(
  candidates: readonly DuplicateCandidate[],
  existing:   readonly ExistingAssetRef[],
): DuplicateScan {
  const byChecksum = new Map<string, ExistingAssetRef>()
  for (const e of existing) {
    if (!byChecksum.has(e.checksum)) byChecksum.set(e.checksum, e)
  }

  const matches:    DuplicateMatch[]     = []
  const fresh:      DuplicateCandidate[] = []
  const intraBatch: DuplicateMatch[]     = []
  const seenInBatch = new Map<string, DuplicateCandidate>()

  for (const c of candidates) {
    const stored = byChecksum.get(c.checksum)
    if (stored) {
      matches.push({ itemId: c.itemId, checksum: c.checksum, existing: stored })
      continue
    }

    const earlier = seenInBatch.get(c.checksum)
    if (earlier) {
      intraBatch.push({
        itemId: c.itemId,
        checksum: c.checksum,
        // The earlier queue item stands in for the "existing" asset — it has no assetId yet.
        // MS-FINAL-01 · the intra-batch stand-in has no stored asset, so the descriptive
        // fields are empty rather than invented — the UI reads 'earlier in this batch'.
        existing: {
          assetId: earlier.itemId, checksum: c.checksum, galleryId: '', albumId: null,
          originalFilename: null, uploadedAtMs: 0,
        },
      })
      continue
    }

    seenInBatch.set(c.checksum, c)
    fresh.push(c)
  }

  return { matches, fresh, intraBatch }
}

/** What a resolution means for one item. */
export interface ResolutionEffect {
  /** Upload it? */
  upload: boolean
  /** Overwrite the existing asset record rather than creating a new one? */
  replaceAssetId: string | null
}

export function applyResolution(
  match: DuplicateMatch,
  resolution: DuplicateResolution,
): ResolutionEffect {
  switch (resolution) {
    case 'skip':
      return { upload: false, replaceAssetId: null }
    case 'replace':
      // Re-upload and point at the SAME asset record, so the gallery keeps one entry and
      // any link to it stays valid.
      return { upload: true, replaceAssetId: match.existing.assetId }
    case 'keep-both':
      // A deliberate second copy — a new asset id, same checksum. The checksum column is
      // therefore not unique by design, and duplicate scanning reports the first match.
      return { upload: true, replaceAssetId: null }
    default: {
      const never: never = resolution
      throw new Error(`Unknown duplicate resolution: ${String(never)}`)
    }
  }
}

export function isDuplicateResolution(v: unknown): v is DuplicateResolution {
  return typeof v === 'string' && (DUPLICATE_RESOLUTIONS as readonly string[]).includes(v)
}
