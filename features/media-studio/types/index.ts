// RD-MEDIA-01 · Media Studio — domain types.
//
// SDK-FREE by contract: no firebase-admin, no @aws-sdk, no next/*, no React. Firestore
// Timestamps are typed `unknown`, matching every existing document type in this codebase.
//
// Media Studio is a PLATFORM module. It stores bytes only through
// `@/features/platform-storage` and never names Cloudflare R2.

export const MEDIA_GALLERIES   = 'mediaGalleries'
export const MEDIA_ALBUMS      = 'mediaAlbums'
export const MEDIA_ASSETS      = 'mediaAssets'
export const MEDIA_SETTINGS    = 'mediaSettings'
/** RD-MEDIA-04 · bulk operation batches — generic `lib/jobs` Jobs. */
export const MEDIA_JOBS        = 'mediaJobs'

/** Bump when a stored shape changes; readers refuse an unknown version. */
export const MEDIA_SCHEMA_VERSION = 1

// ─── Galleries ────────────────────────────────────────────────────────────────

/**
 * The suggestion key a gallery was created from, persisted as `preset`.
 *
 * RD-MEDIA-02: this used to be a union of marathon-specific literals, which made Media
 * Studio — a PLATFORM module — know about road races. It is now an opaque string resolved
 * from the event's own template (lib/events/galleryTemplates.ts), plus 'custom' for an
 * organizer-named gallery.
 *
 * WIDENING IS BACKWARD COMPATIBLE: every previously-valid literal is still a valid string,
 * and the marathon template still emits those exact keys, so galleries created before this
 * change keep matching their suggestion and are never offered twice.
 */
export type GalleryPreset = string

/** mediaGalleries/{galleryId} */
export interface GalleryDoc {
  galleryId:     string
  schemaVersion: number
  organizerUid:  string      // tenant isolation key
  eventId:       string      // users/{uid}/eventDrafts/{eventId}
  eventSlug:     string      // events/{slug} — also the storage path segment
  name:          string
  preset:        GalleryPreset
  /** URL-safe, unique within the event. */
  slug:          string
  description:   string | null
  /** Denormalised counters, maintained transactionally with asset writes. */
  assetCount:    number
  albumCount:    number
  bytesStored:   number
  /** Sum of the SOURCE sizes before compression — the other half of "space saved". */
  bytesOriginalSource: number
  coverAssetId:  string | null
  createdBy:     string
  createdAt:     unknown
  updatedAt:     unknown
}

// ─── Albums ───────────────────────────────────────────────────────────────────

/** mediaAlbums/{albumId} — always inside exactly one gallery. */
export interface AlbumDoc {
  albumId:       string
  schemaVersion: number
  organizerUid:  string
  eventId:       string
  eventSlug:     string
  galleryId:     string
  name:          string
  slug:          string
  description:   string | null
  assetCount:    number
  bytesStored:   number
  bytesOriginalSource: number
  coverAssetId:  string | null
  createdBy:     string
  createdAt:     unknown
  updatedAt:     unknown
}

/** Suggested album names — a convenience, never enforced. */
export const ALBUM_SUGGESTIONS: readonly string[] = [
  'Camera 1', 'Camera 2', 'Camera 3', 'Drone', 'VIP',
]

// ─── Media assets ─────────────────────────────────────────────────────────────

export type MediaRendition = 'original' | 'medium' | 'thumbnail'

export const MEDIA_RENDITIONS: readonly MediaRendition[] = ['original', 'medium', 'thumbnail']

/** One stored rendition. `path` is a storage KEY, never a URL. */
export interface RenditionRecord {
  path:     string
  size:     number
  mimeType: string
  width:    number | null
  height:   number | null
}

export type MediaAssetStatus =
  | 'pending'    // presigned URLs issued; bytes not yet confirmed
  | 'ready'      // every rendition confirmed in the bucket
  | 'failed'     // upload or processing failed
  | 'deleted'    // removed from the bucket; record retained for audit

/**
 * RD-MEDIA-04 — statuses whose OBJECTS are reclaimable.
 *
 * `pending` is an upload that was authorized and never finished; `deleted` is one whose
 * object removal was best-effort and may have failed. Both leave bytes in the bucket that
 * nothing points at, so both are swept. Neither contributes to a counter, so reclaiming
 * them can never change a total.
 */
export const RECLAIMABLE_STATUSES: readonly MediaAssetStatus[] = ['pending', 'deleted']

/**
 * How long a signed upload URL is valid. A queue item that sits longer re-requests one.
 *
 * ═══ WHY IT LIVES HERE ════════════════════════════════════════════════════════
 * RD-MS-HOTFIX-01. It used to be declared in `services/uploadService`, and `utils/bulkOps`
 * imported it from there to document its relationship with `RECLAIM_AFTER_MS`. That single
 * VALUE import was an edge from a pure util into a service that boots the storage stack —
 * so the moment a client component imported `bulkOps`, the bundler followed it all the way
 * to `lib/env` and the browser blew up on a server-only environment assertion.
 *
 * This module imports nothing. Putting the constant at the leaf inverts the edge: the
 * service and the util now both READ it, and neither reads the other.
 */
export const UPLOAD_URL_TTL_SECONDS = 900   // 15 minutes

/**
 * mediaAssets/{assetId}
 *
 * ONLY metadata. Image bytes live exclusively in object storage — this document never
 * holds a data URL, a base64 blob, or anything but keys and numbers.
 */
export interface MediaAssetDoc {
  assetId:       string
  schemaVersion: number
  organizerUid:  string
  eventId:       string
  eventSlug:     string
  galleryId:     string
  albumId:       string | null

  /** sha256 of the ORIGINAL bytes — the duplicate-detection key. */
  checksum:      string
  /** Uploader's filename, retained as data only; never used as a storage key. */
  originalFilename: string | null

  renditions:    Partial<Record<MediaRendition, RenditionRecord>>
  /** Bytes actually stored across every rendition. */
  bytesStored:   number
  /** Size of the file the organizer selected, before compression. */
  bytesOriginalSource: number

  mimeType:      string
  width:         number | null
  height:        number | null
  /** Which compression profile produced this asset. */
  profileId:     string
  status:        MediaAssetStatus
  visibility:    'PUBLIC' | 'PRIVATE' | 'SIGNED_URL'

  uploadedBy:    string
  uploadedAt:    unknown
  updatedAt:     unknown
  /**
   * RD-MS-CLOSURE-01 · how many times this photo has been downloaded.
   *
   * The one metric that says whether the product is working: an event whose photos are never
   * downloaded is an event whose storage bill buys nothing. Nothing counted it before.
   *
   * Counted on the PUBLIC and ATTENDEE download routes — the two places a participant
   * actually takes a photo away. The organizer's own download is deliberately NOT counted:
   * an organizer checking their own gallery is not demand, and mixing the two would make the
   * number useless for the decision it exists to inform.
   *
   * Incremented with `FieldValue.increment`, so concurrent downloads cannot lose a count, and
   * best-effort — a failed counter must never fail a download. Absent on every photo uploaded
   * before this sprint; `?? 0` on read.
   */
  downloadCount?: number
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** mediaSettings/{organizerUid} — one document per workspace. */
export interface MediaSettingsDoc {
  organizerUid:       string
  schemaVersion:      number
  defaultProfileId:   string
  generateThumbnail:  boolean
  generateMedium:     boolean
  keepOriginal:       boolean
  defaultVisibility:  'PUBLIC' | 'SIGNED_URL'
  /**
   * RD-MEDIA-08 — per-event limit overrides, keyed by eventId.
   *
   * The TOP layer of the limit hierarchy (event → plan → global). Stored on this document
   * rather than in a new collection because `/uploads/prepare` already reads it, so an
   * override costs the upload path zero additional reads.
   *
   * Bounded in practice: a workspace with 500 events holds ~500 small objects, far inside
   * Firestore's 1 MiB document ceiling. Optional and additive — absent on every existing
   * document, which resolves to "no event override".
   */
  eventLimitOverrides?: Record<string, Partial<import('@/lib/config/businessConfig').MediaOverridableConfig>>
  updatedAt:          unknown
}

export const DEFAULT_MEDIA_SETTINGS: Omit<MediaSettingsDoc, 'organizerUid' | 'updatedAt'> = {
  schemaVersion:     MEDIA_SCHEMA_VERSION,
  defaultProfileId:  'balanced',
  generateThumbnail: true,
  generateMedium:    true,
  keepOriginal:      true,
  // Race photography is published to participants, so PUBLIC is the useful default. An
  // organizer who wants gated photos switches this to SIGNED_URL.
  defaultVisibility: 'PUBLIC',
}

// ─── Serialised views (no Timestamp crosses the wire) ─────────────────────────

export interface GalleryView {
  galleryId:   string
  name:        string
  slug:        string
  preset:      GalleryPreset
  description: string | null
  assetCount:  number
  albumCount:  number
  bytesStored: number
  createdAt:   string | null
}

export interface AlbumView {
  albumId:     string
  galleryId:   string
  name:        string
  slug:        string
  description: string | null
  assetCount:  number
  bytesStored: number
  createdAt:   string | null
}

export interface MediaAssetView {
  assetId:     string
  galleryId:   string
  albumId:     string | null
  checksum:    string
  originalFilename: string | null
  bytesStored: number
  mimeType:    string
  width:       number | null
  height:      number | null
  status:      MediaAssetStatus
  /** RD-MEDIA-06 — so the organizer browser can show and change it. */
  visibility:  'PUBLIC' | 'PRIVATE' | 'SIGNED_URL'
  uploadedAt:  string | null
  /**
   * RD-MS-CLOSURE-01 · fields the photo detail drawer shows. All already on the document.
   *
   * Added to the VIEW rather than fetched separately: the drawer opens on a photo the grid
   * has already loaded, so a second round trip would buy nothing. `profileId` and
   * `bytesOriginalSource` together are what let an organizer see what compression actually
   * did to one photo instead of only the gallery-wide average on the storage dashboard.
   */
  profileId:   string
  bytesOriginalSource: number
  /** Downloads by participants. 0 for photos uploaded before the counter existed. */
  downloadCount: number
  /** Which renditions were actually stored, for the drawer's storage breakdown. */
  renditionNames: string[]
  /** Resolved per visibility at read time; null when it cannot be resolved. */
  thumbnailUrl: string | null
  /**
   * RD-PHOTO-08 · The best rendition available for a LARGE display.
   *
   * Priority `medium` → `original` → `thumbnail`, the reverse of `thumbnailUrl`'s.
   *
   * Two URLs rather than one because they answer different questions. `thumbnailUrl` is the
   * 400px grid tile — correct and cheap for a gallery of sixty. This is for a hero preview,
   * where that same 400px file is a 4× upscale and renders as a blur.
   *
   * Null unless the caller opts in with `?preview=1`, so the gallery's payload and its
   * signing cost are unchanged.
   */
  previewUrl: string | null
}

// ─── Bulk operations (RD-MEDIA-04) ────────────────────────────────────────────

/**
 * What a bulk job does to every asset in its scope.
 *
 * `move` is METADATA-ONLY and that is a property of the storage layout, not a shortcut: an
 * object key is `events/{eventSlug}/photos/{rendition}/{objectId}` and carries no gallery or
 * album segment. Moving a photo between galleries therefore copies no bytes and cannot fail
 * halfway through a 40 MB transfer.
 */
export type MediaBulkAction = 'delete' | 'move' | 'visibility'

export const MEDIA_BULK_ACTIONS: readonly MediaBulkAction[] = ['delete', 'move', 'visibility']

export function isMediaBulkAction(v: unknown): v is MediaBulkAction {
  return typeof v === 'string' && (MEDIA_BULK_ACTIONS as readonly string[]).includes(v)
}

/** Visibility an organizer may assign. `PRIVATE` is included: it is a withdrawal, not a leak. */
export type AssignableVisibility = 'PUBLIC' | 'PRIVATE' | 'SIGNED_URL'

export const ASSIGNABLE_VISIBILITIES: readonly AssignableVisibility[] =
  ['PUBLIC', 'PRIVATE', 'SIGNED_URL']

export function isAssignableVisibility(v: unknown): v is AssignableVisibility {
  return typeof v === 'string' && (ASSIGNABLE_VISIBILITIES as readonly string[]).includes(v)
}

/** Storage dashboard payload. */
export interface StorageUsageView {
  bytesStored:        number
  bytesOriginalSource: number
  bytesSaved:         number
  savingsPercent:     number
  photoCount:         number
  averageFileSize:    number
  galleryCount:       number
  albumCount:         number
}
