// GET /api/public/events/{slug}/photos/download?photoId=
//
// RD-PUBGAL-01. Redirects to a freshly signed URL for one public photo.
//
// ─── Why signed, when the object is already public ───────────────────────────
// Three reasons, none of them access control — the access control is that the photo is
// PUBLIC and its event is exposable, and both are re-checked here:
//
//   1. The signature carries an EXPIRY, so a URL scraped from a redirect stops working.
//   2. The download is attributable to a route we control rather than to the bucket.
//   3. It works even when the bucket has no public base URL configured (`R2_PUBLIC_URL`),
//      which is the stricter deployment posture.
//
// The bytes do NOT pass through this server. It redirects, so a 40 MB original costs one
// signature rather than 40 MB of egress through a serverless function.

import { NextRequest, NextResponse } from 'next/server'
import { resolvePublicDownload } from '@/features/public-gallery/services/publicGalleryService'
import { recordDownload } from '@/features/media-studio/repositories/assetRepo'

type Params = { params: Promise<{ slug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { slug } = await params
  const photoId  = req.nextUrl.searchParams.get('photoId')?.trim() ?? ''

  if (!photoId) {
    return NextResponse.json({ error: 'photoId is required' }, { status: 400 })
  }

  const outcome = await resolvePublicDownload(slug, photoId)
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error },
      { status: outcome.status, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  // RD-MS-CLOSURE-01 · count the download. Deliberately NOT awaited: a counter must never
  // sit between a participant and their photo, and `recordDownload` swallows its own
  // failures. Placed after the outcome check, so only a download that actually happens is
  // counted — a 404 is not demand.
  void recordDownload(photoId)

  // 302, never 301: a permanent redirect would be cached by the browser and pin a visitor to
  // one expiring signature forever.
  return NextResponse.redirect(outcome.url, {
    status: 302,
    headers: {
      // The signature expires in minutes, so this response must never be cached.
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${outcome.filename}"`,
    },
  })
}
