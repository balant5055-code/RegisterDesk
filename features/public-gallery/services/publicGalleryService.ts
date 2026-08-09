// RD-PUBGAL-01 · Public gallery reads — SERVER ONLY.
//
// ═══ THE ACCESS CHAIN ═════════════════════════════════════════════════════════
// Two gates, both required, in this order:
//
//   1. THE EVENT must be publicly exposable — `canExposePublicEvent(lifecycleStatus)`, the
//      platform's existing allow-list. A draft, an unlisted or a moderated-down event has no
//      gallery, whatever its photos say.
//   2. THE PHOTO must be `visibility === 'PUBLIC'` — enforced IN THE QUERY, not filtered
//      afterwards.
//
// The bridge that makes this cheap: `events/{slug}` already stores `uid` and `draftId`, so
// an event slug resolves to the organizer and event id that the media repositories are
// ALREADY indexed by. No new lookup collection, no denormalised copy, no new gallery index.
// ══════════════════════════════════════════════════════════════════════════════
//
// Storage is reached only through @/features/platform-storage. This module never names
// Cloudflare R2 and never returns an object key.

import { storage } from '@/features/platform-storage'
import { resolveRenditionUrl } from '@/features/media-studio/services/uploadService'
import { getEventBySlug } from '@/lib/firebase/firestore/events'
import { canExposePublicEvent } from '@/lib/events/publicVisibility'
import { isContentTakenDown } from '@/lib/admin/moderation'
// RD-MS-CLOSURE-01 · the SAME resolver the organizer side uses. No parallel config path.
import { resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
import { listGalleries, listAlbums } from '@/features/media-studio/repositories/galleryRepo'
import {
  countPublicAssets, getPublicAsset, listPublicAssets,
} from '@/features/media-studio/repositories/assetRepo'
import { MEDIA_SCHEMA_VERSION, type MediaAssetDoc } from '@/features/media-studio/types'
import {
  DOWNLOAD_RENDITION_PREFERENCE, GRID_RENDITION_PREFERENCE, LIGHTBOX_RENDITION_PREFERENCE,
  isPubliclyVisible, pickRendition, toPublicGallery, toPublicPhoto, withPublicPhotos,
} from '@/features/public-gallery/utils/projection'
import {
  PHOTOS_MAX_PAGE_SIZE, PHOTOS_PAGE_SIZE,
  type PublicAlbumSummary, type PublicGalleryDetail, type PublicGalleryIndex,
  type PublicPhotoPage,
} from '@/features/public-gallery/types'

/** A download signature is used immediately after the redirect; it needs no longer. */
const DOWNLOAD_URL_TTL_SECONDS = 300

/** Galleries listed on the landing page. Media Studio caps a gallery list at 200 anyway. */
const MAX_GALLERIES = 60

export interface PublicEventContext {
  organizerUid: string
  eventId:      string
  eventSlug:    string
  eventName:    string
}

/**
 * Resolves an event slug to the keys the media repositories need — or null.
 *
 * Null covers every reason a gallery must not exist: no such event, a lifecycle state that
 * is not publicly exposable, or content taken down by moderation. The caller renders a 404
 * for all of them, so none of them is distinguishable from outside.
 */
export async function resolvePublicEvent(eventSlug: string): Promise<PublicEventContext | null> {
  const event = await getEventBySlug(eventSlug)
  if (!event) return null
  if (!canExposePublicEvent(event.lifecycleStatus)) return null
  // The same moderation gate the event detail page applies. A taken-down event has no
  // gallery, exactly as it has no page.
  if (isContentTakenDown(event.moderationStatus)) return null

  const raw = event as unknown as Record<string, unknown>
  const organizerUid = typeof raw.uid === 'string' ? raw.uid : ''
  const eventId      = typeof raw.draftId === 'string' ? raw.draftId : ''
  // An event published before these were stamped has no way to reach its media. It simply
  // has no gallery, rather than falling back to an unscoped query.
  if (!organizerUid || !eventId) return null

  // ═══ RD-MS-CLOSURE-01 · the publicGalleryEnabled switch ═══════════════════
  // `businessConfig.mediaStudio.publicGalleryEnabled` documented itself as the master switch
  // for /events/{slug}/gallery and had ZERO consumers. It was editable by admins, overridable
  // per event, and displayed as effective in MediaLimitsPanel — and every gallery stayed live
  // whatever it said. An operator switching it off during a takedown believed the galleries
  // were dark; they were fully public.
  //
  // Enforced HERE and nowhere else, because this function is the one gate every public path
  // already passes through: both gallery pages, the photo list API and the download route all
  // call it. A second check anywhere else would be a second rule to keep in step.
  //
  // Resolved global → plan → event, so a single event can be taken down without touching the
  // platform default, and the platform default takes down everything.
  const config = await resolveMediaConfig({ organizerUid, eventId, eventSlug })
  if (!config.publicGalleryEnabled) return null

  const details = raw.eventDetails as { info?: { name?: unknown } } | undefined
  const eventName = typeof details?.info?.name === 'string' ? details.info.name : 'This event'

  return { organizerUid, eventId, eventSlug, eventName }
}

/**
 * The viewable URL for one rendition of a public photo.
 *
 * RD-MEDIA-07: delegates to the SHARED resolver rather than calling `storage.resolveUrl`
 * directly. This function used to do the latter, and on a bucket with no `R2_PUBLIC_URL` it
 * threw for every photo, caught the error, and returned null — so the gallery found the
 * photo, counted it, and rendered a placeholder.
 *
 * The shared resolver prefers the durable public URL (cacheable, free to serve) and falls
 * back to a signature when the bucket has no public domain. Preferring public still matters:
 * a signed URL cannot be cached, and at a few dozen tiles per pageview that is a signature
 * per tile per visitor.
 */
async function publicUrlFor(asset: MediaAssetDoc, preference: readonly ('original' | 'medium' | 'thumbnail')[]) {
  const chosen = pickRendition(asset, preference)
  if (!chosen) return null
  // The asset is PUBLIC — `isPubliclyVisible` has already established that — so the strategy
  // is public-with-signed-fallback, never a gated signature.
  return resolveRenditionUrl(chosen.path, 'PUBLIC')
}

function downloadHref(eventSlug: string, assetId: string): string {
  return `/api/public/events/${encodeURIComponent(eventSlug)}/photos/download?photoId=${encodeURIComponent(assetId)}`
}

// ─── Landing page ─────────────────────────────────────────────────────────────

/**
 * Every gallery with at least one public photo.
 *
 * Cost is one gallery list plus one aggregate `count()` per gallery — no document scan. A
 * gallery whose public count is zero is dropped entirely: an empty card would advertise that
 * the gallery exists and its contents are withheld, which the organizer did not publish.
 */
export async function getPublicGalleryIndex(
  ctx: PublicEventContext,
): Promise<PublicGalleryIndex> {
  const galleries = (await listGalleries(ctx.organizerUid, ctx.eventId)).slice(0, MAX_GALLERIES)

  const cards = await Promise.all(galleries.map(async gallery => {
    const [photoCount, cover] = await Promise.all([
      countPublicAssets(ctx.organizerUid, gallery.galleryId),
      // One photo, only for the cover tile.
      listPublicAssets({ organizerUid: ctx.organizerUid, galleryId: gallery.galleryId, limit: 1 }),
    ])

    const coverAsset = cover.assets[0]
    const coverUrl = coverAsset && isPubliclyVisible(coverAsset, MEDIA_SCHEMA_VERSION)
      ? await publicUrlFor(coverAsset, GRID_RENDITION_PREFERENCE)
      : null

    return toPublicGallery(gallery, photoCount, coverUrl)
  }))

  const visible = withPublicPhotos(cards)

  return {
    eventName:   ctx.eventName,
    eventSlug:   ctx.eventSlug,
    galleries:   visible,
    totalPhotos: visible.reduce((n, g) => n + g.photoCount, 0),
  }
}

// ─── One gallery ──────────────────────────────────────────────────────────────

export async function getPublicGallery(
  ctx: PublicEventContext, gallerySlug: string,
): Promise<PublicGalleryDetail | null> {
  const galleries = await listGalleries(ctx.organizerUid, ctx.eventId)
  const gallery = galleries.find(g => g.slug === gallerySlug)
  if (!gallery) return null

  const photoCount = await countPublicAssets(ctx.organizerUid, gallery.galleryId)
  // A gallery with no public photos is indistinguishable from one that does not exist.
  if (photoCount === 0) return null

  const [initial, albumDocs] = await Promise.all([
    listPublicPhotos(ctx, gallery.galleryId, { limit: PHOTOS_PAGE_SIZE }),
    listAlbums(ctx.organizerUid, gallery.galleryId),
  ])

  const albums: PublicAlbumSummary[] = (await Promise.all(
    albumDocs.map(async album => ({
      slug: album.slug,
      name: album.name,
      photoCount: await countPublicAssets(ctx.organizerUid, gallery.galleryId, album.albumId),
    })),
  )).filter(a => a.photoCount > 0)

  const coverUrl = initial.photos[0]?.url ?? null

  return {
    eventName: ctx.eventName,
    eventSlug: ctx.eventSlug,
    gallery:   toPublicGallery(gallery, photoCount, coverUrl),
    albums,
    initial,
  }
}

/** Resolves an album SLUG to its id within a gallery. Public URLs never carry an id. */
export async function resolveAlbumId(
  ctx: PublicEventContext, galleryId: string, albumSlug: string | null,
): Promise<string | null> {
  if (!albumSlug) return null
  const albums = await listAlbums(ctx.organizerUid, galleryId)
  return albums.find(a => a.slug === albumSlug)?.albumId ?? null
}

/** Resolves a gallery SLUG to its id. */
export async function resolveGalleryId(
  ctx: PublicEventContext, gallerySlug: string,
): Promise<string | null> {
  const galleries = await listGalleries(ctx.organizerUid, ctx.eventId)
  return galleries.find(g => g.slug === gallerySlug)?.galleryId ?? null
}

// ─── The grid ─────────────────────────────────────────────────────────────────

/**
 * One page of public photos.
 *
 * The visibility filter is in the QUERY, so a page of 36 is 36 public photos — not 36 rows
 * of which some are dropped. `isPubliclyVisible` still runs as a belt-and-braces check on
 * every row, because a projection is the wrong place to trust an index.
 */
export async function listPublicPhotos(
  ctx: PublicEventContext,
  galleryId: string,
  opts: { albumId?: string | null; limit?: number; cursor?: string | null } = {},
): Promise<PublicPhotoPage> {
  const limit = Math.min(Math.max(1, opts.limit ?? PHOTOS_PAGE_SIZE), PHOTOS_MAX_PAGE_SIZE)

  const page = await listPublicAssets({
    organizerUid: ctx.organizerUid,
    galleryId,
    albumId: opts.albumId ?? null,
    limit,
    cursor:  opts.cursor ?? null,
  })

  const photos = await Promise.all(page.assets.map(async asset => {
    if (!isPubliclyVisible(asset, MEDIA_SCHEMA_VERSION)) return null

    const [url, largeUrl] = await Promise.all([
      publicUrlFor(asset, GRID_RENDITION_PREFERENCE),
      publicUrlFor(asset, LIGHTBOX_RENDITION_PREFERENCE),
    ])
    if (!url || !largeUrl) return null

    return toPublicPhoto({
      asset, url, largeUrl,
      downloadUrl: downloadHref(ctx.eventSlug, asset.assetId),
    })
  }))

  return {
    photos: photos.filter((p): p is NonNullable<typeof p> => p !== null),
    // From the QUERY page, not the projected result: paging must advance past a row that
    // failed to resolve a URL, or the grid would stall on it forever.
    nextCursor: page.nextCursor,
  }
}

// ─── Download ─────────────────────────────────────────────────────────────────

export type DownloadOutcome =
  | { ok: true;  url: string; filename: string }
  | { ok: false; status: number; error: string }

/**
 * A freshly signed URL for one public photo.
 *
 * SIGNED even though the object is public and has a durable URL. Three reasons: the
 * signature carries an expiry, the response is attributable to a route we control, and a
 * download works even when the bucket has no public base URL configured. It also re-checks
 * EVERY gate — event exposability, tenant, event, status and visibility — so a photo that
 * stops being public stops downloading the moment it does.
 */
export async function resolvePublicDownload(
  eventSlug: string, photoId: string,
): Promise<DownloadOutcome> {
  const ctx = await resolvePublicEvent(eventSlug)
  if (!ctx) return { ok: false, status: 404, error: 'Not found.' }

  const asset = await getPublicAsset(photoId)
  if (!asset) return { ok: false, status: 404, error: 'Photo not found.' }

  // The asset must belong to THIS event and THIS organizer. Without both, a valid photo id
  // from one event would download through another event's URL.
  if (asset.organizerUid !== ctx.organizerUid || asset.eventId !== ctx.eventId) {
    return { ok: false, status: 404, error: 'Photo not found.' }
  }
  if (!isPubliclyVisible(asset, MEDIA_SCHEMA_VERSION)) {
    return { ok: false, status: 404, error: 'Photo not found.' }
  }

  const chosen = pickRendition(asset, DOWNLOAD_RENDITION_PREFERENCE)
  if (!chosen) return { ok: false, status: 404, error: 'Photo not found.' }

  try {
    const url = await storage.generateSignedUrl({
      path: chosen.path, operation: 'read', expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    })
    const extension = asset.mimeType === 'image/png' ? 'png'
      : asset.mimeType === 'image/webp' ? 'webp'
      : asset.mimeType === 'image/avif' ? 'avif'
      : 'jpg'
    // Named for the event, never after the stored object — an object id would leak the
    // storage layout into a visitor's downloads folder.
    return {
      ok: true, url,
      filename: `${ctx.eventSlug}-${asset.assetId.slice(-8)}.${extension}`,
    }
  } catch {
    return { ok: false, status: 503, error: 'Photo storage is unavailable. Please try again shortly.' }
  }
}

