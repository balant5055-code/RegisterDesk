// GET /api/public/events/{slug}/photos?gallery=&album=&cursor=&limit=
//
// RD-PUBGAL-01. One page of an event's PUBLIC photos.
//
// Genuinely public — no session, no cookie. Both gates still run on every request: the event
// must be publicly exposable, and only `visibility === 'PUBLIC'` assets are returned, with
// the filter IN the query rather than applied afterwards.
//
// The caller names a gallery and an album by SLUG. Ids never appear in a public URL, and a
// slug that does not resolve within THIS event is a 404 — so a gallery id from another event
// cannot be read through this route.

import { NextRequest, NextResponse } from 'next/server'
import {
  listPublicPhotos, resolveAlbumId, resolveGalleryId, resolvePublicEvent,
} from '@/features/public-gallery/services/publicGalleryService'
import {
  PHOTOS_MAX_PAGE_SIZE, PHOTOS_PAGE_SIZE, type PublicPhotoPage,
} from '@/features/public-gallery/types'

type Params = { params: Promise<{ slug: string }> }

/**
 * RD-PHOTO-03: photos and nothing else.
 *
 * Branding used to ride along here so the browser could composite at download time. It no
 * longer does — the stored photo IS the branded photo, so a public download is an ordinary
 * file download and this response is back to being just a page.
 */
export type PublicPhotosResponse = PublicPhotoPage

/**
 * Cached at the edge for a minute, matching the public event page's own `revalidate = 60`.
 *
 * Safe because the payload is identical for every visitor — it contains only PUBLIC photos
 * and durable public URLs, with no signature and nothing per-person. `stale-while-revalidate`
 * keeps scrolling fast while a page refreshes behind it.
 */
const CACHE_CONTROL = 'public, max-age=60, stale-while-revalidate=300'

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { slug } = await params

  const ctx = await resolvePublicEvent(slug)
  if (!ctx) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const query       = req.nextUrl.searchParams
  const gallerySlug = query.get('gallery')?.trim() ?? ''
  if (!gallerySlug) {
    return NextResponse.json({ error: 'gallery is required' }, { status: 400 })
  }

  const galleryId = await resolveGalleryId(ctx, gallerySlug)
  if (!galleryId) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const albumSlug = query.get('album')?.trim() || null
  const albumId   = await resolveAlbumId(ctx, galleryId, albumSlug)
  // An album slug that names nothing in this gallery is a 404, not a silent fall-through to
  // the whole gallery — otherwise a typo quietly shows more than was asked for.
  if (albumSlug && !albumId) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const rawLimit = Number(query.get('limit') ?? PHOTOS_PAGE_SIZE)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(1, Math.floor(rawLimit)), PHOTOS_MAX_PAGE_SIZE)
    : PHOTOS_PAGE_SIZE

  const page = await listPublicPhotos(ctx, galleryId, {
    albumId,
    limit,
    cursor: query.get('cursor'),
  })

  const body: PublicPhotosResponse = page
  return NextResponse.json(body, { headers: { 'Cache-Control': CACHE_CONTROL } })
}
