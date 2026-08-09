// RD-RESULTS-PUBLIC-FIX-01 · What a finisher can be told about their photos — SERVER ONLY.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// RD-RESULTS-PUBLIC-01 found the runner journey ends at the badge. Everything needed to
// continue it was already built and shipped — the public gallery, the participant photo page,
// and bib detection that matches photos against THIS snapshot — and nothing linked them.
//
// ═══ WHAT THIS IS NOT ═════════════════════════════════════════════════════════
// Not a photo system, not a second gallery reader, and not a new endpoint. It calls
// `resolvePublicEvent` and `getPublicGalleryIndex` — the SAME functions the gallery pages
// use, so the `publicGalleryEnabled` switch, the moderation gate and the lifecycle gate are
// all honoured here for free rather than re-expressed.
//
// It returns a STATE rather than a boolean because the four cases mean different things to a
// runner and deserve different words: "there are none yet" is a promise, "the gallery is off"
// is a decision, and telling one as the other is worse than silence.

import { getPublicGalleryIndex, resolvePublicEvent } from '@/features/public-gallery'

export type ResultPhotoState =
  /** The organizer publishes no public gallery for this event. Say nothing about photos. */
  | 'unavailable'
  /** A gallery exists but holds no public photos yet — they may still be uploading. */
  | 'pending'
  /** Public photos exist. */
  | 'available'

export interface ResultPhotoAccess {
  state: ResultPhotoState
  /** Public photos across every gallery. 0 unless `state === 'available'`. */
  photoCount: number
  /** The event gallery, when there is one to link to. */
  galleryHref: string | null
  /**
   * The participant's OWN photos, found by the identity they verify on that page.
   *
   * Always offered when a gallery exists, even at zero public photos: a participant's photos
   * can be gated while the gallery is otherwise empty, and that page explains its own
   * identity check. The bib is NEVER a parameter — see RD-RUNNER-01.
   */
  myPhotosHref: string | null
}

const NONE: ResultPhotoAccess = {
  state: 'unavailable', photoCount: 0, galleryHref: null, myPhotosHref: null,
}

/**
 * Resolves what to show a finisher about photos.
 *
 * Fails SOFT: any error returns `unavailable`, so a photo read can never take down a result
 * page. A runner looking up their finish time must get it even if the gallery is broken.
 */
export async function resolveResultPhotos(eventSlug: string): Promise<ResultPhotoAccess> {
  try {
    // `resolvePublicEvent` already applies every gate — lifecycle, moderation, and the
    // `publicGalleryEnabled` switch. A null here IS "no public gallery for this event".
    const ctx = await resolvePublicEvent(eventSlug)
    if (!ctx) return NONE

    const index = await getPublicGalleryIndex(ctx)
    const galleryHref = `/events/${encodeURIComponent(eventSlug)}/gallery`
    const myPhotosHref = `/events/${encodeURIComponent(eventSlug)}/photos`

    return index.totalPhotos > 0
      ? { state: 'available', photoCount: index.totalPhotos, galleryHref, myPhotosHref }
      : { state: 'pending',   photoCount: 0,                 galleryHref, myPhotosHref }
  } catch {
    return NONE
  }
}
