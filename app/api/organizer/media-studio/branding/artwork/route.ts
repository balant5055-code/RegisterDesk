// GET /api/organizer/media-studio/branding/artwork?eventId=
//
// RD-PHOTO-03. The overlay's BYTES, from our own origin.
//
// ─── Why this route exists ───────────────────────────────────────────────────
// The import pipeline draws the artwork onto a canvas, which is a cross-origin pixel read.
// Serving it here removes the dependency on bucket CORS entirely — the one risk that could
// have made branding silently do nothing while thousands of photos were permanently stored
// unbranded.
//
// It is called ONCE PER IMPORT RUN, not once per photo and never per download, so relaying
// a ≤2 MB PNG through the app server is negligible. Nothing else in the platform relays
// image bytes, and nothing else should.
//
// Authenticated with the same gate as the rest of Media Studio, and the key comes from the
// organizer's own branding record — never from the request, so this cannot be turned into a
// reader for arbitrary storage keys.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { getOverlayDoc } from '@/features/photo-branding/services/brandingService'
import { storage } from '@/features/platform-storage'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const doc = await getOverlayDoc(authz.workspaceUid, eventId)
  if (!doc) return NextResponse.json({ error: 'No branding artwork.' }, { status: 404 })

  let object
  try {
    object = await storage.download(doc.path)
  } catch {
    return NextResponse.json({ error: 'The branding artwork could not be read.' }, { status: 502 })
  }

  // Private: it is reached with a bearer token and belongs to one organizer. Caching it at
  // a shared edge would be wrong even though the content is not sensitive.
  return new NextResponse(new Uint8Array(object.body), {
    headers: {
      'Content-Type':  object.mimeType,
      'Content-Length': String(object.size),
      'Cache-Control': 'private, no-store',
    },
  })
}
