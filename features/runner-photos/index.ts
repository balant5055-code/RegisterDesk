// RD-RUNNER-01 · Runner Photo Gallery — the module's PUBLIC surface.
//
// Routes and pages import from HERE and nothing deeper.
//
// ─── Contract ────────────────────────────────────────────────────────────────
//   • A participant can only ask for "MY photos". Bib, organizer, asset and gallery are all
//     DERIVED from their verified session — never accepted as input.
//   • Identity reuses the EXISTING attendee email-OTP session. No new auth, no new cookie.
//   • Only CONFIRMED registrations resolve. Draft registrations are unreachable.
//   • APPROVED PHOTOS ONLY. A link reaches a participant when `reviewStatus === 'verified'`
//     and never otherwise — an allow-list, so `pending` and any future status are withheld
//     by default. Nothing a human has not checked is shown to anyone.
//   • Storage is reached only through @/features/platform-storage. Every URL is SIGNED and
//     short-lived; no object key, bucket or storage URL ever reaches a participant.
//   • This module WRITES NOTHING and owns no collection. It is a read model over
//     photoBibLinks (RD-BIB-01) and mediaAssets (RD-MEDIA-01).
//   • No matching logic. No runner, result, name or bib is duplicated.
//
// Architecture: docs/RD-RUNNER-PHOTO-GALLERY.md

// ── Access (server-only) ────────────────────────────────────────────────────
export {
  listRunnerPhotos, resolvePhotoDownload, resolveRunner,
} from './services/photoAccess'
export type { ResolvedRunner } from './services/photoAccess'

// ── UI ──────────────────────────────────────────────────────────────────────
export { RunnerPhotoGallery } from './components/RunnerPhotoGallery'
export { PhotoVerifyPanel }   from './components/PhotoVerifyPanel'

// ── Pure projection (no SDK, no I/O — unit-tested) ──────────────────────────
export {
  DISPLAY_RENDITION_PREFERENCE, DOWNLOAD_RENDITION_PREFERENCE, UNKNOWN_GALLERY_NAME,
  isServableAsset, isVisibleLink, pickRendition, toRunnerPhoto,
} from './utils/projection'
export type { ProjectionInput } from './utils/projection'

// ── Domain types ────────────────────────────────────────────────────────────
export { PHOTOS_MAX_PAGE_SIZE, PHOTOS_PAGE_SIZE } from './types'
export type {
  PhotoAccessDenial, RunnerPhotoAccess, RunnerPhotoOutcome, RunnerPhotoPage, RunnerPhotoView,
} from './types'
