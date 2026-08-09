// RD-PUBGAL-01 · Public Event Photo Gallery — domain types.
//
// SDK-FREE by contract: no firebase-admin, no @aws-sdk, no next/*, no React.
//
// ═══ NO NEW COLLECTION, NO NEW MODEL ══════════════════════════════════════════
// This module stores NOTHING and owns no collection. It is a public read model over what
// Media Studio already holds:
//
//   events/{slug} → { uid, draftId }   ← the bridge: an eventSlug resolves to the
//                                        organizer + event id the media repositories
//                                        are already indexed by
//   mediaGalleries · mediaAlbums · mediaAssets
//
// Every query below reuses an index that already exists, except the two visibility-filtered
// ones this sprint adds.
// ══════════════════════════════════════════════════════════════════════════════

/** Photos per page in the grid. Cursor-paginated; never an offset. */
export const PHOTOS_PAGE_SIZE = 36
export const PHOTOS_MAX_PAGE_SIZE = 72

/**
 * ═══ THE VISIBILITY RULE ══════════════════════════════════════════════════════
 * Only `PUBLIC` assets appear here. That is the whole access model, and the three values
 * mean genuinely different things:
 *
 *   PUBLIC      → anyone. This gallery.
 *   SIGNED_URL  → gated. Reachable by the participant it belongs to, through the verified
 *                 runner gallery (RD-RUNNER-01) — NOT here.
 *   PRIVATE     → nowhere. Server-side only.
 *
 * So the two photo surfaces are complementary rather than overlapping, and an organizer
 * moves photos between them with the visibility control (RD-MEDIA-04), not by a separate
 * publish flag that could disagree with it.
 * ══════════════════════════════════════════════════════════════════════════════
 */
export const PUBLIC_VISIBILITY = 'PUBLIC' as const

/**
 * One photo, as a visitor sees it.
 *
 * No storage key, no bucket, no object id, no organizer uid, no event id, no asset id, no
 * checksum, no uploader, no original filename, no album id.
 */
export interface PublicPhoto {
  /** Opaque handle. Only ever resolves for a PUBLIC asset of a PUBLIC event. */
  photoId: string
  /** Display rendition — a durable, CDN-cacheable URL for a PUBLIC object. */
  url: string
  /** Full-size rendition for the lightbox. */
  largeUrl: string
  width:  number | null
  height: number | null
  /** Our own route: it re-checks visibility and signs on the click. */
  downloadUrl: string
  /**
   * ALWAYS null. EXIF is discarded by Media Studio's browser-side re-encode, so the
   * platform has never held a capture time. Never substituted with the upload time.
   */
  capturedAt: string | null
}

export interface PublicPhotoPage {
  photos: PublicPhoto[]
  /** Opaque; pass back as `cursor`. Null when there is nothing more. */
  nextCursor: string | null
}

/** A gallery on the landing page. */
export interface PublicGallerySummary {
  slug: string
  name: string
  description: string | null
  /**
   * PUBLIC photos only — never the gallery's `assetCount`, which counts every ready asset
   * regardless of visibility. Showing that would both misstate the gallery and disclose how
   * many photos exist that this visitor may not see.
   */
  photoCount: number
  /** First public photo, for the cover tile. Null when the gallery has none. */
  coverUrl: string | null
}

/** An album within a gallery. Albums subdivide; they never gate. */
export interface PublicAlbumSummary {
  slug: string
  name: string
  photoCount: number
}

export interface PublicGalleryIndex {
  eventName: string
  eventSlug: string
  galleries: PublicGallerySummary[]
  totalPhotos: number
}

export interface PublicGalleryDetail {
  eventName: string
  eventSlug: string
  gallery:   PublicGallerySummary
  albums:    PublicAlbumSummary[]
  /** First page, rendered on the server so the grid paints without a round trip. */
  initial:   PublicPhotoPage
}
