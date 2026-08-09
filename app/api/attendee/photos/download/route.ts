// GET /api/attendee/photos/download?photoId=
//
// RD-RUNNER-01. Redirects to a freshly signed URL for one of the caller's own photos.
//
// ─── Why a redirect rather than returning the URL ────────────────────────────
// A signed URL is short-lived by design. If the gallery handed one out at page load, a
// participant who opened the tab an hour ago would click Download and get an XML error from
// object storage. This route mints the signature at the moment of the click, so the link in
// the page never expires — while the signature it produces still does, minutes later.
//
// Ownership is re-derived from the session on EVERY call. `photoId` is not a capability:
// holding one proves nothing, and a photo that stops being the caller's stops resolving here
// the moment it does.
//
// The bytes do NOT pass through this server. It redirects, so a 40 MB original costs the
// platform one signature rather than 40 MB of egress through a serverless function.

import { NextRequest, NextResponse } from 'next/server'
import { resolvePhotoDownload } from '@/features/runner-photos/services/photoAccess'
import { recordDownload } from '@/features/media-studio/repositories/assetRepo'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const photoId   = req.nextUrl.searchParams.get('photoId')?.trim() ?? ''
  const eventSlug = req.nextUrl.searchParams.get('eventSlug')?.trim() || null

  if (!photoId) {
    return NextResponse.json({ error: 'photoId is required' }, { status: 400 })
  }

  const outcome = await resolvePhotoDownload(eventSlug, photoId)
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error },
      { status: outcome.status, headers: { 'Cache-Control': 'no-store, private' } },
    )
  }

  // RD-MS-CLOSURE-01 · count the download. Same posture as the public route: not awaited,
  // failures swallowed, and only counted once the outcome is known to be a real download.
  // This is the participant taking their own photo away, which is exactly the demand signal
  // the counter exists to capture.
  void recordDownload(photoId)

  // 302, never 301: a permanent redirect would be cached by the browser and would pin a
  // participant to one expiring signature forever.
  return NextResponse.redirect(outcome.url, {
    status: 302,
    headers: {
      'Cache-Control': 'no-store, private',
      // Advisory: object storage sets its own disposition, but this is what the browser
      // sees first and it keeps the storage layout out of the participant's downloads.
      'Content-Disposition': `attachment; filename="${outcome.filename}"`,
    },
  })
}
