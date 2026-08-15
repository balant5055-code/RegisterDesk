// RD-STORAGE-01 · Platform Storage — domain types.
//
// SDK-FREE by contract: no @aws-sdk, no firebase-admin, no next/*, no React. These types
// describe storage in RegisterDesk's own vocabulary, so a business module never learns
// anything about S3, R2, or any other vendor.
//
// If a type here ever needs an S3 concept to express itself, the abstraction has leaked.

// ─── Visibility ───────────────────────────────────────────────────────────────

/**
 * How an object may be reached.
 *
 *  PUBLIC     — served from the bucket's public URL. Anyone with the link can read it.
 *               For assets that are already public by nature (event banners, sponsor logos).
 *  PRIVATE    — no public URL at all. Reachable only by a server-side download.
 *  SIGNED_URL — private at rest, but a short-lived signed URL may be minted server-side.
 *
 * CERTIFICATES MUST NOT BE `PUBLIC`. A certificate carries a participant's name and result;
 * the existing module treats its identifiers as capability tokens, and this layer keeps that
 * property. `assertCertificateVisibility` enforces it (utils/validation.ts).
 */
export type StorageVisibility = 'PUBLIC' | 'PRIVATE' | 'SIGNED_URL'

export const STORAGE_VISIBILITIES: readonly StorageVisibility[] =
  ['PUBLIC', 'PRIVATE', 'SIGNED_URL']

// ─── Asset classification ─────────────────────────────────────────────────────

/**
 * What an object IS. Drives the bucket path and the default visibility — a caller never
 * hand-writes a path or picks a visibility by eye.
 */
export type StorageAssetType =
  | 'event-banner'
  | 'event-photo-original'
  | 'event-photo-medium'
  | 'event-photo-thumbnail'
  | 'event-certificate'
  | 'event-finisher-badge'
  /** RD-PHOTO-01 — the organizer's transparent branding overlay for one event. */
  | 'event-branding-overlay'
  | 'event-report'
  /** RD-CERT-TPL-R2 — an organizer's uploaded certificate TEMPLATE file (pdf/png/jpg).
   *  Private: it is the organizer's design asset, never public. */
  | 'event-certificate-template'
  | 'marketing-logo'
  | 'marketing-sponsor'
  | 'system'

/** Lifecycle of the stored object's metadata record. */
export type StorageAssetStatus =
  | 'pending'    // reserved; bytes not confirmed (e.g. a signed direct upload was issued)
  | 'active'     // bytes are in the bucket
  | 'deleted'    // removed from the bucket; the record is retained for audit

// ─── Asset metadata ───────────────────────────────────────────────────────────

/**
 * The metadata record for one stored object.
 *
 * `path` is the object KEY inside the bucket — never a URL, and never a filesystem path.
 * A URL is derived on demand, because it depends on visibility and on the provider.
 *
 * NOTE ON ORIGINAL FILENAMES: the stored key is always a generated id. The uploader's
 * filename lives ONLY in `originalFilename`, as data. That prevents path traversal, unicode
 * and case-collision bugs, and information disclosure through a URL.
 */
export interface StorageAssetMetadata {
  /** Stable id for this asset. Also the basis of the object key. */
  id:           string
  /** Owning event, when the asset belongs to one. null for marketing/system assets. */
  eventId:      string | null
  type:         StorageAssetType
  /** Object key within the bucket. */
  path:         string
  /** Size in bytes. */
  size:         number
  mimeType:     string
  /** Content hash — sha256 hex. Used for integrity and duplicate detection. */
  checksum:     string
  visibility:   StorageVisibility
  /** Uid of the actor who uploaded it. */
  uploadedBy:   string
  /** ISO-8601. A plain string, so this type stays SDK-free. */
  uploadedAt:   string
  status:       StorageAssetStatus
  /** The uploader's filename, retained as DATA only — never used to build a key. */
  originalFilename: string | null
  /** Free-form provider-agnostic tags. Kept small; not a document store. */
  tags?:        Readonly<Record<string, string>>
}

// ─── Operation inputs / outputs ───────────────────────────────────────────────

export interface UploadInput {
  /** Where it goes — the path builder derives the key from this. */
  type:      StorageAssetType
  /** Required for every `event-*` type; must be null for marketing/system. */
  eventSlug: string | null
  body:      Uint8Array
  mimeType:  string
  uploadedBy: string
  /** Retained as metadata only. */
  originalFilename?: string | null
  /** Overrides the type's default. Rejected when it would make a certificate PUBLIC. */
  visibility?: StorageVisibility
  eventId?:    string | null
  tags?:       Record<string, string>
  /** Supply to make an upload idempotent — the same id overwrites the same key. */
  id?:         string
}

export interface UploadResult {
  metadata: StorageAssetMetadata
  /** Present only for PUBLIC assets. Private objects have no durable URL by design. */
  publicUrl: string | null
}

export interface DownloadResult {
  body:     Uint8Array
  mimeType: string
  size:     number
}

export interface ObjectMetadata {
  path:     string
  size:     number
  mimeType: string
  /** ISO-8601, or null when the provider does not report it. */
  updatedAt: string | null
  checksum:  string | null
}

export interface ListOptions {
  /** Key prefix to list under. */
  prefix: string
  /** Hard cap per call. Providers also enforce their own ceiling. */
  limit?: number
  /** Opaque continuation token from a previous page. */
  cursor?: string | null
}

export interface ListResult {
  objects:    ObjectMetadata[]
  nextCursor: string | null
}

export type SignedUrlOperation = 'read' | 'write'

export interface SignedUrlOptions {
  path:      string
  operation: SignedUrlOperation
  /** Seconds. Clamped by the provider to a sane maximum. */
  expiresIn?: number
  /** For `write`, the content type the URL is valid for. */
  mimeType?:  string
  /**
   * RD-CERT-ARTIFACT-01 — `read` only. The `Content-Disposition` the STORE should send
   * back with the object, so a browser following the URL downloads instead of rendering.
   *
   * WHY THIS EXISTS. A certificate download used to be streamed by our own route, which
   * set `Content-Disposition: attachment` itself. Serving the stored artifact by redirect
   * moves the bytes out of the function, and with them the ability to set that header —
   * the browser would open the PDF inline and the caller would lose the download semantics
   * every consumer of that route depends on. S3-compatible stores accept the header as a
   * SIGNED query parameter, so it cannot be tampered with after the fact.
   *
   * Providers with no gateway to honour it (the local development filesystem) ignore it.
   */
  responseContentDisposition?: string
}
