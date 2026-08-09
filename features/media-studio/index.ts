// RD-MEDIA-01 · Media Studio — the module's PUBLIC surface.
//
// Route files import from HERE and nothing deeper.
//
// ─── Contract ────────────────────────────────────────────────────────────────
//   • Bytes are stored ONLY through @/features/platform-storage. This module never
//     imports an S3 SDK and never names Cloudflare R2.
//   • Firestore holds METADATA only — never an image byte, never a data URL.
//   • Uploads are authorized SERVER-side: the server validates, chooses the key and mints
//     the signature; the browser holds no credentials.
//   • Permissions reuse the EXISTING `events` permission. No new RBAC.

export { GalleriesClient }        from './components/GalleriesClient'
export { ImportClient }           from './components/ImportClient'
export { SettingsClient }         from './components/SettingsClient'
export { StorageDashboardClient } from './components/StorageDashboardClient'
export {
  MediaEventPicker, StorageNotConfigured, StudioNavCard, StudioSection, StudioStat,
} from './components/MediaStudioShell'

// ── RD-MEDIA-03 · the workspace ────────────────────────────────────────────
// ONE event for the whole of Media Studio, held in the layout so it survives navigation.
export {
  EVENT_PARAM, FROM_PARAM, MediaStudioProvider, useMediaStudio, withEvent,
} from './context/MediaStudioContext'
export type { MediaStudioContextValue } from './context/MediaStudioContext'
export { EventContextBar }    from './components/EventContextBar'
export { MediaStudioHeader }  from './components/MediaStudioHeader'

export { useUploadQueue }  from './hooks/useUploadQueue'
export type { QueueItem, UploadQueue, UploadTarget } from './hooks/useUploadQueue'
export { useMediaEvents }  from './hooks/useMediaEvents'
export type { MediaEventRow } from './hooks/useMediaEvents'

// ── Pure engines (no SDK, no DOM, no I/O — unit-tested) ─────────────────────
export {
  COMPRESSION_PROFILES, CUSTOM_PROFILE_ID, DEFAULT_PROFILE_ID, CUSTOM_LIMITS,
  buildCustomProfile, defaultProfile, estimateBatch, estimateCompressedBytes,
  estimateStoredBytes, findProfile, resolveProfile,
} from './utils/compressionProfiles'
export type { CompressionProfile, BatchEstimate } from './utils/compressionProfiles'

export {
  MAX_CONCURRENT_UPLOADS, canTransition, countByState, isActive, isQueueSettled,
  isRetryable, isTerminal, nextState, queueProgressPercent, selectNextToStart,
} from './utils/queueMachine'
export type { QueueAction, QueueCounts, UploadItemState } from './utils/queueMachine'

export {
  applyResolution, isDuplicateResolution, scanForDuplicates,
  DUPLICATE_RESOLUTIONS, DEFAULT_DUPLICATE_RESOLUTION,
} from './utils/duplicates'
export type {
  DuplicateCandidate, DuplicateMatch, DuplicateResolution, DuplicateScan, ExistingAssetRef,
} from './utils/duplicates'

export {
  isGalleryPreset, presetName, toSlug, uniqueSlug, validateDescription, validateName,
} from './utils/naming'

export {
  classifyUploadError, formatUploadFailure, hasRetryableFailure, summariseFailures,
} from './utils/uploadErrors'

// ── RD-MEDIA-04 · backend completion ───────────────────────────────────────
// Bulk operations reuse the lib/jobs kernel; reclamation sweeps stranded objects.
export { createBulkJob, runBulkChunk } from './jobs/bulkAssetJob'
export { RECLAIM_AFTER_MS, bulkJobId } from './utils/bulkOps'
// RD-MEDIA-05 — ONE maintenance implementation, shared by the cron route and the manual page.
export { getMaintenanceStatus, runMediaMaintenance } from './services/maintenanceService'
export type { MaintenanceRun, MaintenanceStatus, MaintenanceTrigger } from './services/maintenanceService'
export { MaintenanceClient } from './components/MaintenanceClient'
// RD-MEDIA-08 — effective limits, resolved by lib/config/resolveMediaConfig.
export { MediaLimitsPanel } from './components/MediaLimitsPanel'
export { EventOverridesPanel } from './components/EventOverridesPanel'
export { GalleryBrowserClient } from './components/GalleryBrowserClient'
export type { MediaBulkJob, CreateBulkJobInput, CreateBulkOutcome } from './jobs/bulkAssetJob'
export { reclaimAbandonedObjects } from './services/reclamationService'
export type { ReclaimReport } from './services/reclamationService'
export type { UploadFailure, UploadFailureKind } from './utils/uploadErrors'

// ── Domain types ────────────────────────────────────────────────────────────
// RD-MEDIA-02: gallery suggestions come from lib/events/galleryTemplates.ts — re-exported
// here so a consumer of this module finds them without importing Media Studio internals.
export { resolveGalleryTemplate, CUSTOM_GALLERY_KEY } from '@/lib/events/galleryTemplates'
export type { GalleryTemplate, GallerySuggestion } from '@/lib/events/galleryTemplates'

export type {
  AlbumView, GalleryPreset, GalleryView, MediaAssetView, MediaAssetStatus,
  MediaRendition, MediaSettingsDoc, StorageUsageView,
} from './types'
export {
  ALBUM_SUGGESTIONS, MEDIA_RENDITIONS, DEFAULT_MEDIA_SETTINGS,
  ASSIGNABLE_VISIBILITIES, MEDIA_BULK_ACTIONS, MEDIA_JOBS, RECLAIMABLE_STATUSES,
  isAssignableVisibility, isMediaBulkAction,
} from './types'
export type { AssignableVisibility, MediaBulkAction } from './types'
