// RD-PUBGAL-01 · The public projection — THE security boundary.
//
// PURE. No SDK, no I/O. Kept outside the service so what a stranger can be shown is provable
// by test rather than inferred from a Firestore trace — the same discipline as Sprint 4's
// `toPublicRace` and Sprint 10's runner-photo projection.
//
// ═══ WHAT THIS GUARANTEES ═════════════════════════════════════════════════════
// It CONSTRUCTS its output field by field and never spreads an input. An asset carries
// storage keys, a checksum, the uploader's uid, the original filename and the tenant; a
// gallery carries the event id and a total that counts photos this visitor may not see.
// None of it can reach a browser, because there is no path from those fields to the
// returned object.
// ══════════════════════════════════════════════════════════════════════════════

import type { GalleryDoc, MediaAssetDoc, MediaRendition } from '@/features/media-studio/types'
import { PUBLIC_VISIBILITY, type PublicGallerySummary, type PublicPhoto } from '@/features/public-gallery/types'

/** Grid tile: small enough to load dozens of, large enough to recognise. */
export const GRID_RENDITION_PREFERENCE: readonly MediaRendition[] =
  ['medium', 'thumbnail', 'original']

/** Lightbox: the best the organizer kept. */
export const LIGHTBOX_RENDITION_PREFERENCE: readonly MediaRendition[] =
  ['original', 'medium', 'thumbnail']

/** Download: same as the lightbox — a visitor saving a photo wants the full one. */
export const DOWNLOAD_RENDITION_PREFERENCE: readonly MediaRendition[] =
  LIGHTBOX_RENDITION_PREFERENCE

/**
 * Whether an asset may be shown to the public.
 *
 * An ALLOW-LIST on visibility, not a deny-list. `PUBLIC` is the only value that passes;
 * `SIGNED_URL` (gated, for the participant's own verified gallery) and `PRIVATE` (nowhere)
 * both fail, as does any value a future sprint adds. A deny-list would admit them silently.
 */
export function isPubliclyVisible(asset: MediaAssetDoc, schemaVersion: number): boolean {
  if (asset.schemaVersion !== schemaVersion) return false
  if (asset.status !== 'ready') return false          // pending, failed, soft-deleted
  if (asset.visibility !== PUBLIC_VISIBILITY) return false
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

export interface PhotoProjectionInput {
  asset:       MediaAssetDoc
  /** Resolved by the caller — a durable public URL for a PUBLIC object. */
  url:         string
  largeUrl:    string
  downloadUrl: string
}

/**
 * Builds what a visitor receives.
 *
 * Dimensions come from the ORIGINAL where recorded, because that is what the lightbox and a
 * download deliver; reporting the grid tile's size would tell a visitor the wrong thing
 * about the file they are about to save.
 */
export function toPublicPhoto(input: PhotoProjectionInput): PublicPhoto {
  return {
    photoId:  input.asset.assetId,
    url:      input.url,
    largeUrl: input.largeUrl,
    width:    input.asset.width,
    height:   input.asset.height,
    downloadUrl: input.downloadUrl,
    // Always null — see the type. Never substitute `uploadedAt`.
    capturedAt: null,
  }
}

/**
 * Builds a gallery card.
 *
 * `photoCount` is passed in from a visibility-filtered aggregate, NOT read from
 * `gallery.assetCount`. That counter includes every ready asset whatever its visibility, so
 * publishing it would both misstate the gallery and disclose how many photos exist that this
 * visitor cannot see.
 */
export function toPublicGallery(
  gallery: GalleryDoc, photoCount: number, coverUrl: string | null,
): PublicGallerySummary {
  return {
    slug:        gallery.slug,
    name:        gallery.name,
    description: gallery.description,
    photoCount,
    coverUrl,
  }
}

/**
 * Galleries worth showing.
 *
 * A gallery with no public photos is hidden entirely rather than rendered as an empty card:
 * an empty card advertises that the gallery exists and that its contents are withheld, which
 * is information the organizer did not choose to publish.
 */
export function withPublicPhotos(
  galleries: readonly PublicGallerySummary[],
): PublicGallerySummary[] {
  return galleries.filter(g => g.photoCount > 0)
}

/** Alt text for a grid tile. Descriptive without inventing anything about the photo. */
export function photoAltText(eventName: string, galleryName: string, index: number): string {
  return `${eventName} — ${galleryName}, photo ${index + 1}`
}
