// RD-PUBGAL-01 · Public Event Photo Gallery — the module's PUBLIC surface.
//
// Pages and routes import from HERE and nothing deeper.
//
// ─── Contract ────────────────────────────────────────────────────────────────
//   • TWO gates on every read: the EVENT must be publicly exposable
//     (`canExposePublicEvent` + moderation), and the PHOTO must be `visibility: 'PUBLIC'`.
//   • The visibility filter is IN THE QUERY, never applied after fetching.
//   • This module WRITES NOTHING and owns no collection. It is a read model over Media
//     Studio's `mediaGalleries` / `mediaAlbums` / `mediaAssets`.
//   • No new repository. The public reads are additive functions on the repository that
//     already owns those collections — a parallel query layer is how two places end up
//     disagreeing about what "public" means.
//   • Storage only through @/features/platform-storage. No object key ever reaches a
//     browser; downloads go through our own signed route.
//   • Public URLs carry SLUGS, never ids.
//
// Architecture: docs/RD-PUBLIC-GALLERY.md

// ── Reads (server-only) ─────────────────────────────────────────────────────
export {
  getPublicGallery, getPublicGalleryIndex, listPublicPhotos, resolveAlbumId,
  resolveGalleryId, resolvePublicDownload, resolvePublicEvent,
} from './services/publicGalleryService'
export type { PublicEventContext, DownloadOutcome } from './services/publicGalleryService'

// ── UI ──────────────────────────────────────────────────────────────────────
export { PublicPhotoGrid } from './components/PublicPhotoGrid'
export { GalleryHero }     from './components/GalleryHero'
export { GalleryCta }      from './components/GalleryCta'
// The lightbox is the SHARED one — components/event-templates/shared/ui/ImageLightbox.

// ── Pure projection (no SDK, no I/O — unit-tested) ──────────────────────────
export {
  DOWNLOAD_RENDITION_PREFERENCE, GRID_RENDITION_PREFERENCE, LIGHTBOX_RENDITION_PREFERENCE,
  isPubliclyVisible, photoAltText, pickRendition, toPublicGallery, toPublicPhoto,
  withPublicPhotos,
} from './utils/projection'
export type { PhotoProjectionInput } from './utils/projection'

// ── Domain types ────────────────────────────────────────────────────────────
export { PHOTOS_MAX_PAGE_SIZE, PHOTOS_PAGE_SIZE, PUBLIC_VISIBILITY } from './types'
export type {
  PublicAlbumSummary, PublicGalleryDetail, PublicGalleryIndex, PublicGallerySummary,
  PublicPhoto, PublicPhotoPage,
} from './types'
