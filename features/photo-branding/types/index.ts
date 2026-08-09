// RD-PHOTO-01 · Event photo branding — domain types.
//
// SDK-FREE: no firebase-admin, no @aws-sdk, no next/*, no React.
//
// ═══ NO NEW COLLECTION ════════════════════════════════════════════════════════
// The overlay record lives on the EXISTING `mediaSettings/{organizerUid}` document, in a map
// keyed by eventId — the same shape `eventLimitOverrides` uses (RD-MEDIA-08). That document
// is already read on the upload path and by every Media Studio surface, so branding costs no
// new collection, no new rule and no new index.
//
// The BYTES live in object storage under `events/{eventSlug}/branding/`, reached only
// through `@/features/platform-storage`. This module never names Cloudflare R2.
// ══════════════════════════════════════════════════════════════════════════════

import type { BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'

/** mediaSettings/{organizerUid}.branding[eventId] */
export interface BrandingOverlayDoc {
  /** Storage KEY, never a URL. A URL is resolved on every read (RD-MEDIA-07). */
  path:      string
  mimeType:  string
  bytes:     number
  width:     number
  height:    number
  /** Which placement rule applies. One value today; the field exists so adding one is data. */
  style:     BrandingStyle
  /**
   * Whether branding is applied to downloads.
   *
   * Separate from presence on purpose: an organizer turning branding off should not have to
   * delete artwork they will want back next season.
   */
  enabled:   boolean
  uploadedBy: string
  uploadedAt: string   // ISO
  updatedAt:  string   // ISO
}

/** What a client receives. Carries a resolved URL and never a storage key. */
export interface BrandingOverlayView {
  url:       string
  width:     number
  height:    number
  bytes:     number
  style:     BrandingStyle
  enabled:   boolean
  uploadedAt: string
  updatedAt:  string
}

export interface BrandingState {
  /** Null when this event has no overlay. */
  overlay: BrandingOverlayView | null
  /** True when an overlay exists AND is enabled — the condition a download checks. */
  active:  boolean
}
