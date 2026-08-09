// GET /api/organizer/media-studio/assets?galleryId=&albumId=&cursor=&visibility=&sort=&q=
//
// A page of photo metadata. Cursor-paginated — never an offset — so page N of a 50,000-photo
// gallery costs what page 1 costs.
//
// ═══ RD-MS-CLOSURE-01 · FILTER, SORT, SEARCH ═════════════════════════════════
// Until this sprint the only way to reach photo #40,000 was 667 sequential pages in upload
// order. Three refinements were added, and WHERE each one runs is deliberate:
//
//   visibility · IN THE QUERY. Served by an index that already exists (the public gallery
//                has used `..., visibility, status, uploadedAt` since RD-PUBGAL-01), so the
//                page size stays honest — 60 requested is 60 real matches.
//   sort       · IN THE QUERY. A direction flip on the same index; Firestore reads an index
//                both ways, so this adds no artifact.
//   q          · A PAGE-LOCAL refinement over `originalFilename`, and labelled as one in the
//                response. Firestore cannot do substring matching, and the honest options
//                were a page-local filter or a search index. A search index is a new
//                infrastructure dependency, which this sprint forbids — so the filter is
//                scoped to the page and the client is TOLD it is, rather than pretending to
//                have searched the gallery.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import { getOwnedGallery } from '@/features/media-studio/repositories/galleryRepo'
import { listAssets, serializeAsset } from '@/features/media-studio/repositories/assetRepo'
import { resolveRenditionUrl } from '@/features/media-studio/services/uploadService'
import type { MediaAssetView } from '@/features/media-studio/types'

export interface AssetListResponse {
  assets:     MediaAssetView[]
  nextCursor: string | null
  /**
   * RD-MS-CLOSURE-01 · true when `q` narrowed THIS PAGE rather than the gallery.
   *
   * The client renders "matches on this page" instead of "matches" when set. Silence here
   * would let an organizer read "3 results" as "3 photos in the gallery are named that",
   * which is a different and much stronger claim than the one the server can make.
   */
  searchScopedToPage?: boolean
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const url       = new URL(req.url)
  const galleryId = url.searchParams.get('galleryId')?.trim() ?? ''
  const albumId   = url.searchParams.get('albumId')?.trim() || null
  const cursor    = url.searchParams.get('cursor')?.trim() || null

  // RD-MS-CLOSURE-01 · an unrecognised value is IGNORED rather than rejected. These are view
  // refinements arriving from a URL a person may have edited; a 400 would break the page
  // instead of showing it unfiltered.
  const rawVisibility = url.searchParams.get('visibility')?.trim() ?? ''
  const visibility = rawVisibility === 'PUBLIC' || rawVisibility === 'PRIVATE'
    || rawVisibility === 'SIGNED_URL' ? rawVisibility : null
  const sort = url.searchParams.get('sort')?.trim() === 'oldest' ? 'oldest' : 'newest'
  const query = (url.searchParams.get('q')?.trim() ?? '').slice(0, 100).toLowerCase()

  if (!galleryId) return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })

  const gallery = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!gallery) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  const page = await listAssets({
    organizerUid: authz.workspaceUid, galleryId, albumId, cursor, visibility, sort,
  })

  // Thumbnail URLs are resolved per asset because visibility decides the answer: a PUBLIC
  // photo gets a durable CDN URL, a SIGNED_URL photo a short-lived one.
  // RD-PHOTO-08 — `?preview=1` additionally resolves the best LARGE rendition.
  //
  // Opt-in on purpose. The gallery browser lists sixty assets per page and paints them into
  // small tiles, where the 400px thumbnail is both correct and cheap; resolving a second URL
  // for every one of them would double this route's signing work for no benefit. Without the
  // flag the response is byte-identical to before.
  const wantPreview = req.nextUrl.searchParams.get('preview') === '1'

  // RD-MS-CLOSURE-01 · applied BEFORE the URLs are resolved, so a filtered-out photo costs no
  // signature. `nextCursor` is deliberately untouched: it must keep pointing at the real end
  // of the page, or paging with a search term would skip everything the filter removed.
  const matched = query
    ? page.assets.filter(a => (a.originalFilename ?? '').toLowerCase().includes(query))
    : page.assets

  const assets = await Promise.all(matched.map(async a => {
    const thumb    = a.renditions.thumbnail ?? a.renditions.medium ?? a.renditions.original
    const thumbUrl = thumb ? await resolveRenditionUrl(thumb.path, a.visibility) : null

    // Reverse priority: the largest rendition that exists. `thumbnail` is a last resort,
    // reached only when an import produced nothing else.
    const large = wantPreview
      ? (a.renditions.medium ?? a.renditions.original ?? a.renditions.thumbnail)
      : null
    const largeUrl = large ? await resolveRenditionUrl(large.path, a.visibility) : null

    return serializeAsset(a, thumbUrl, largeUrl)
  }))

  const body: AssetListResponse = {
    assets, nextCursor: page.nextCursor,
    ...(query ? { searchScopedToPage: true } : {}),
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
