// RD-RUNNER-01 · Runner photo access — SERVER ONLY.
//
// ═══ THE SECURITY INVARIANT ═══════════════════════════════════════════════════
// A participant can only ever ask for "MY photos". They cannot name a bib, a runner, an
// asset, a gallery or an organizer.
//
//   attendee session (OTP-verified email)   ← the only input that is trusted
//        └─▶ registrations · attendee.email == session email, status == 'confirmed'
//             └─▶ organizerUid + bibNumber   ← READ from the registration, never supplied
//                  └─▶ photoBibLinks · (organizerUid, eventSlug, bibKey)
//                       └─▶ mediaAssets      ← batched, tenant-checked, projected
//
// The bib is the pivot, and it is never a parameter. Bib numbers are printed on the public
// leaderboard, so accepting one from a caller would be no authentication at all.
//
// `registrations` is queried through `lib/attendee/data.ts`, whose contract is that every
// query is scoped to the session's email and there is no by-id path. Draft registrations are
// unreachable: only `status === 'confirmed'` resolves.
//
// A SECOND gate sits downstream of identity: only links a HUMAN has approved
// (`reviewStatus === 'verified'`) are ever projected — see `isVisibleLink`. Proving who you
// are gets you your approved photos, not everything a model guessed about your bib.
// ══════════════════════════════════════════════════════════════════════════════
//
// Storage is reached ONLY through @/features/platform-storage. This module never names
// Cloudflare R2 and never returns an object key.

import { storage } from '@/features/platform-storage'
import { verifyAttendeeSession } from '@/lib/attendee/auth'
import { findAttendeeEventIdentity } from '@/lib/attendee/data'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
import { BIB_SCHEMA_VERSION } from '@/features/bib-detection/types'
import { getLinkById, listLinksForBib } from '@/features/bib-detection/repositories/photoBibLinkRepo'
import { MEDIA_SCHEMA_VERSION, type MediaAssetDoc } from '@/features/media-studio/types'
import { getAssetsByIds } from '@/features/media-studio/repositories/assetRepo'
import { getGalleriesByIds } from '@/features/media-studio/repositories/galleryRepo'
import {
  DISPLAY_RENDITION_PREFERENCE, DOWNLOAD_RENDITION_PREFERENCE, UNKNOWN_GALLERY_NAME,
  isServableAsset, isVisibleLink, pickRendition, toRunnerPhoto,
} from '@/features/runner-photos/utils/projection'
import {
  PHOTOS_MAX_PAGE_SIZE, PHOTOS_PAGE_SIZE,
  type RunnerPhotoOutcome, type RunnerPhotoPage,
} from '@/features/runner-photos/types'

/**
 * How long a display URL stays valid.
 *
 * Short on purpose: a URL that leaks (a screenshot, a shared devtools trace) stops working
 * within the hour. The gallery re-signs on every page load, so a participant never meets an
 * expiry — but anyone who copied one does.
 */
const DISPLAY_URL_TTL_SECONDS = 900        // 15 minutes

/** A download signature is used immediately after the redirect; it needs no longer. */
const DOWNLOAD_URL_TTL_SECONDS = 300       // 5 minutes

/** The participant's identity at this event. Everything else derives from it. */
export interface ResolvedRunner {
  organizerUid: string
  eventSlug:    string
  eventName:    string
  bibNumber:    string
  bibKey:       string
}

/**
 * Resolves the signed-in participant at one event.
 *
 * Returns a DENIAL REASON rather than throwing, so the page can explain what to do next —
 * "verify your email" and "we have no registration for you here" are different problems and
 * a participant deserves to know which one they have.
 */
export async function resolveRunner(eventSlug: string): Promise<
  { ok: true; runner: ResolvedRunner } | { ok: false; outcome: RunnerPhotoOutcome }
> {
  const session = await verifyAttendeeSession()
  if (!session) return { ok: false, outcome: { ok: false, reason: 'unverified' } }

  const identity = await findAttendeeEventIdentity(session.normalizedEmail, eventSlug)
  if (!identity) return { ok: false, outcome: { ok: false, reason: 'not_registered' } }

  if (!identity.bibNumber) {
    // Registered, but the organizer never assigned a bib — so there is nothing photos could
    // have been matched against. Said plainly rather than shown as "no photos yet".
    return { ok: false, outcome: { ok: false, reason: 'no_bib' } }
  }

  return {
    ok: true,
    runner: {
      organizerUid: identity.organizerUid,
      eventSlug:    identity.eventSlug,
      eventName:    identity.eventName,
      bibNumber:    identity.bibNumber,
      // The SAME normaliser the snapshot and the detector used. Imported, never
      // reimplemented — divergence would make every lookup silently miss.
      bibKey:       bibKey(identity.bibNumber),
    },
  }
}

/**
 * One page of the participant's photos.
 *
 * ─── Why this is O(page), not O(photos) ──────────────────────────────────────
 *   1 indexed, cursor-paginated query for the links   (RD-BIB-01's existing index)
 *   1 batched `getAll` for the assets                 (never a per-photo read)
 *   1 batched `getAll` for the gallery names          (a page spans a handful)
 *   N local HMAC signatures                           (no network — presigning is offline)
 *
 * No collection scan, no offset, no N+1. It costs the same on a 1,000,000-link event as on
 * a 10-link one.
 */
export async function listRunnerPhotos(params: {
  runner: ResolvedRunner
  limit?:  number
  cursor?: string | null
}): Promise<RunnerPhotoPage> {
  const { runner } = params
  const limit = Math.min(Math.max(1, params.limit ?? PHOTOS_PAGE_SIZE), PHOTOS_MAX_PAGE_SIZE)

  const page = await listLinksForBib({
    organizerUid: runner.organizerUid,
    eventSlug:    runner.eventSlug,
    bibKey:       runner.bibKey,
    limit,
    cursor:       params.cursor ?? null,
  })

  const visible = page.links.filter(link => isVisibleLink(link, BIB_SCHEMA_VERSION))
  if (visible.length === 0) return { photos: [], nextCursor: page.nextCursor }

  const assets = await getAssetsByIds(visible.map(l => l.assetId), runner.organizerUid)

  const servable = visible
    .map(link => ({ link, asset: assets.get(link.assetId) }))
    .filter((pair): pair is { link: typeof pair.link; asset: MediaAssetDoc } =>
      isServableAsset(pair.asset, pair.link, MEDIA_SCHEMA_VERSION))

  const galleries = await getGalleriesByIds(
    servable.map(p => p.link.galleryId), runner.organizerUid,
  )

  const photos = await Promise.all(servable.map(async ({ link, asset }) => {
    const display = pickRendition(asset, DISPLAY_RENDITION_PREFERENCE)
    if (!display) return null

    // ALWAYS signed, even when the object is stored PUBLIC. A public URL would be a durable,
    // guessable address for a photograph of a named participant; a signed one expires.
    const thumbnailUrl = await storage.generateSignedUrl({
      path: display.path, operation: 'read', expiresIn: DISPLAY_URL_TTL_SECONDS,
    }).catch(() => null)
    if (!thumbnailUrl) return null

    return toRunnerPhoto({
      link, asset,
      galleryName: galleries.get(link.galleryId)?.name ?? UNKNOWN_GALLERY_NAME,
      thumbnailUrl,
      // Our own route — it re-verifies and re-signs, so a bookmarked link keeps working
      // and stops working when it should.
      downloadUrl: `/api/attendee/photos/download?photoId=${encodeURIComponent(link.linkId)}`,
    })
  }))

  return {
    photos: photos.filter((p): p is NonNullable<typeof p> => p !== null),
    // The cursor comes from the LINK page, not the filtered result: paging must advance
    // past links that were filtered out, or a rejected photo would stall the gallery.
    nextCursor: page.nextCursor,
  }
}

/**
 * A fresh signed URL for one photo the caller has just proven is theirs.
 *
 * Re-verifies from scratch. The `photoId` is not a capability: holding it proves nothing,
 * because ownership is re-derived from the session on every call. A link that stops being
 * the caller's — a corrected bib, a rejected match, a deleted photo — stops resolving here
 * the moment it does.
 */
export async function resolvePhotoDownload(
  eventSlugHint: string | null, photoId: string,
): Promise<{ ok: true; url: string; filename: string } | { ok: false; status: number; error: string }> {
  const session = await verifyAttendeeSession()
  if (!session) return { ok: false, status: 401, error: 'Please verify your email to download your photos.' }

  // The link id embeds the asset and the bib, but nothing here trusts it: the organizer is
  // taken FROM the link, then the caller's own identity at that event is resolved
  // independently and the two bibs must agree.
  const eventSlug = eventSlugHint ?? null
  const link = await getLinkById(photoId)
  if (!link) return { ok: false, status: 404, error: 'Photo not found.' }
  if (eventSlug && link.eventSlug !== eventSlug) {
    return { ok: false, status: 404, error: 'Photo not found.' }
  }

  const identity = await findAttendeeEventIdentity(session.normalizedEmail, link.eventSlug)
  if (!identity?.bibNumber) return { ok: false, status: 403, error: 'This photo is not yours.' }
  if (bibKey(identity.bibNumber) !== link.bibKey) {
    return { ok: false, status: 403, error: 'This photo is not yours.' }
  }
  if (identity.organizerUid !== link.organizerUid) {
    return { ok: false, status: 403, error: 'This photo is not yours.' }
  }
  if (!isVisibleLink(link, BIB_SCHEMA_VERSION)) {
    return { ok: false, status: 404, error: 'Photo not found.' }
  }

  const assets = await getAssetsByIds([link.assetId], link.organizerUid)
  const asset  = assets.get(link.assetId)
  if (!isServableAsset(asset, link, MEDIA_SCHEMA_VERSION)) {
    return { ok: false, status: 404, error: 'Photo not found.' }
  }

  const chosen = pickRendition(asset, DOWNLOAD_RENDITION_PREFERENCE)
  if (!chosen) return { ok: false, status: 404, error: 'Photo not found.' }

  try {
    const url = await storage.generateSignedUrl({
      path: chosen.path, operation: 'read', expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    })
    // Named for the participant, never after the stored object — an object id would leak
    // the storage layout into their downloads folder.
    const extension = asset.mimeType === 'image/png' ? 'png'
      : asset.mimeType === 'image/webp' ? 'webp'
      : asset.mimeType === 'image/avif' ? 'avif'
      : 'jpg'
    return {
      ok: true, url,
      filename: `${link.eventSlug}-bib-${link.bibNumber}-${link.linkId.slice(-6)}.${extension}`,
    }
  } catch {
    return { ok: false, status: 503, error: 'Photo storage is unavailable. Please try again shortly.' }
  }
}
