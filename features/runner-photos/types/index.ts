// RD-RUNNER-01 · Runner Photo Gallery — domain types.
//
// SDK-FREE by contract: no firebase-admin, no @aws-sdk, no next/*, no React.
//
// ═══ NO NEW COLLECTION, NO NEW RELATIONSHIP ═══════════════════════════════════
// This module stores NOTHING. It is a read model over relationships that already exist:
//
//   attendee session (OTP-verified email)  →  registrations  →  bibNumber
//   photoBibLinks (RD-BIB-01)              →  mediaAssets (RD-MEDIA-01)
//
// No runner, result, name or bib is duplicated. No matching logic is re-implemented.
// ══════════════════════════════════════════════════════════════════════════════

/** How many photos one page returns. Cursor-paginated; never an offset. */
export const PHOTOS_PAGE_SIZE = 24
export const PHOTOS_MAX_PAGE_SIZE = 60

/**
 * One photo, as a participant sees it.
 *
 * ─── What is NOT here ────────────────────────────────────────────────────────
 * No storage key, no bucket, no object id, no organizer uid, no event id, no gallery id,
 * no album, no asset id, no confidence, no bounding box, no provider, no review status.
 * A participant gets an opaque handle and two URLs, and nothing about how the platform
 * decided this photo was theirs.
 */
export interface RunnerPhotoView {
  /**
   * Opaque handle for this photo, for THIS participant. It is the link id
   * (`{assetId}__{bibKey}`) and is only ever usable by someone who can prove they hold
   * that bib — every request re-verifies, so the handle is not a capability by itself.
   */
  photoId: string

  /** The gallery the organizer filed it under — "Finish Line", "21 KM". */
  galleryName: string

  /**
   * When the shutter fired, when that is known.
   *
   * ALWAYS null today. EXIF is discarded by the browser-side re-encode in Media Studio
   * (RD-MEDIA-01), so the platform has never had a capture time. Kept in the shape because
   * the field is what a participant actually wants; see docs for what it would take.
   */
  capturedAt: string | null

  /** When the organizer uploaded it. Labelled as such — never presented as a capture time. */
  uploadedAt: string | null

  width:  number | null
  height: number | null

  /** Short-lived signed URL for the display rendition. Never a bucket URL the caller builds. */
  thumbnailUrl: string

  /**
   * OUR route, not a storage URL. It re-verifies ownership and mints a fresh signature on
   * every click, so a link a participant bookmarked still works next month — and stops
   * working the moment it is no longer theirs.
   */
  downloadUrl: string
}

export interface RunnerPhotoPage {
  photos: RunnerPhotoView[]
  /** Opaque; pass back as `cursor`. Null when there is nothing more. */
  nextCursor: string | null
}

/** Why a participant is not seeing photos. Drives the page's state, and nothing else. */
export type PhotoAccessDenial =
  /** No attendee session — they have not verified their email. */
  | 'unverified'
  /** Verified, but this email has no confirmed registration for this event. */
  | 'not_registered'
  /** Registered, but no bib was ever assigned, so nothing can be matched. */
  | 'no_bib'
  /** The event does not exist or is not published. */
  | 'no_event'

export interface RunnerPhotoAccess {
  ok: true
  /** Display name for the header. Read from the registration — not duplicated. */
  bibNumber: string
  eventName: string
}

export type RunnerPhotoOutcome =
  | RunnerPhotoAccess
  | { ok: false; reason: PhotoAccessDenial }
