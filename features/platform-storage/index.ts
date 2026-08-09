// RD-STORAGE-01 · Platform Storage — the module's PUBLIC surface.
//
// Business modules import from HERE and nothing deeper.
//
// ─── The rules ───────────────────────────────────────────────────────────────
//   1. Never import an S3/R2 SDK outside `providers/cloudflare-r2/`.
//   2. Never build an object key by hand — use the service, or `buildObjectKey`.
//   3. Never store an uploader's filename as a key. Ever.
//   4. Uploads and signed URLs are SERVER-ONLY. This module reads secrets; importing it
//      from a client component would leak them into the browser bundle.
//   5. Certificates and reports are never PUBLIC — enforced, not merely documented.
//
// Architecture: docs/RD-STORAGE-ARCHITECTURE.md

// ── The service every module uses ───────────────────────────────────────────
export { StorageService, storage } from './services/StorageService'

// ── The contract a provider implements ──────────────────────────────────────
export type { StorageProvider, ProviderPutInput } from './interfaces/StorageProvider'
export { getProvider, DEFAULT_PROVIDER_ID } from './providers'
export type { StorageProviderId } from './providers'

// ── Domain types ────────────────────────────────────────────────────────────
export type {
  StorageAssetMetadata, StorageAssetStatus, StorageAssetType, StorageVisibility,
  UploadInput, UploadResult, DownloadResult, ObjectMetadata,
  ListOptions, ListResult, SignedUrlOptions, SignedUrlOperation,
} from './types'
export { STORAGE_VISIBILITIES } from './types'

// ── Errors ──────────────────────────────────────────────────────────────────
export { StorageError, isStorageError, storageErrorStatus } from './types/errors'
export type { StorageErrorCode } from './types/errors'

// ── Pure helpers (unit-testable; no SDK, no I/O) ────────────────────────────
export {
  buildObjectKey, buildPrefix, buildEventPrefix, assertSafeKey, assertSafeSlug,
  defaultVisibility, isEventScoped,
} from './utils/paths'
// RD-MEDIA-07 — how a URL is produced, including the public→signed fallback.
export { isDegradedPublicUrl, resolveUrlStrategy } from './utils/urlStrategy'
export type { UrlStrategy } from './utils/urlStrategy'
export {
  generateObjectId, extensionForMime, sanitizeOriginalFilename, objectIdFromKey,
  assertSafeObjectId,
} from './utils/objectKey'
export {
  assertMimeAllowed, assertSizeAllowed, assertExtensionConsistent, assertVisibilityAllowed,
  allowedMimeTypes, maxBytesFor, normalizeMimeType,
} from './utils/validation'
export { sha256Hex, isSameContent } from './utils/checksum'

// ── Provider configuration status (for a health check / admin diagnostic) ────
export { isR2Configured, missingR2Vars } from './providers/cloudflare-r2/config'
