// POST /api/organizer/media-studio/uploads/prepare
//
// Issues one short-lived signed PUT URL per rendition. The browser then PUTs the bytes
// straight to object storage.
//
// The SERVER decides the key, authorizes the caller, and validates type and size before any
// URL exists — a browser cannot upload anything the server did not authorize, because it
// holds no credentials. What the server does NOT do is relay the bytes, which at thousands
// of photos would be a bottleneck and, on a serverless deployment, an outright body-limit
// failure.
//
// Everything goes through @/features/platform-storage. This route never names Cloudflare R2.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import { getOwnedGallery, getOwnedAlbum } from '@/features/media-studio/repositories/galleryRepo'
import { newAssetId } from '@/features/media-studio/repositories/assetRepo'
import { checkSize, resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
// RD-PHOTO-01 — every upload takes one unit of the event's PAID photo capacity, transactionally.
import { reservePhotoUpload } from '@/features/media-studio/services/photoCapacityGate'
import {
  isStorageReady, prepareUploads, type PreparedRendition, type RenditionRequest,
} from '@/features/media-studio/services/uploadService'
import {
  MEDIA_RENDITIONS, type MediaRendition, type RenditionRecord,
} from '@/features/media-studio/types'

export interface PrepareUploadResponse {
  assetId:    string
  renditions: PreparedRendition[]
  /** RD-PHOTO-01 — always null: the organizer-level Media Credits session model is retired. Kept for older clients. */
  sessionId:  string | null
}

/** One prepare call covers ONE photo's renditions — at most three. */
const MAX_RENDITIONS = MEDIA_RENDITIONS.length

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  if (!isStorageReady()) {
    return NextResponse.json(
      { error: 'Media storage is not configured for this deployment.' },
      { status: 503 },
    )
  }

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const galleryId = typeof raw.galleryId === 'string' ? raw.galleryId.trim() : ''
  const albumId   = typeof raw.albumId   === 'string' && raw.albumId.trim() !== ''
    ? raw.albumId.trim() : null

  // RD-PHOTO-01 — `sessionId` / `slotIndex` (the retired Media Credits session model) are ignored.

  if (!galleryId) return NextResponse.json({ error: 'galleryId is required' }, { status: 400 })

  if (!Array.isArray(raw.renditions) || raw.renditions.length === 0) {
    return NextResponse.json({ error: 'renditions[] is required' }, { status: 400 })
  }
  if (raw.renditions.length > MAX_RENDITIONS) {
    return NextResponse.json({ error: `At most ${MAX_RENDITIONS} renditions per photo.` }, { status: 400 })
  }

  const requests: RenditionRequest[] = []
  const seen = new Set<string>()
  for (const entry of raw.renditions) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ error: 'Malformed rendition.' }, { status: 400 })
    }
    const r = entry as Record<string, unknown>
    const rendition = typeof r.rendition === 'string' ? r.rendition : ''
    const mimeType  = typeof r.mimeType  === 'string' ? r.mimeType  : ''
    const size      = typeof r.size === 'number' ? Math.floor(r.size) : NaN

    if (!(MEDIA_RENDITIONS as readonly string[]).includes(rendition)) {
      return NextResponse.json({ error: `Unknown rendition: ${rendition}` }, { status: 400 })
    }
    if (seen.has(rendition)) {
      return NextResponse.json({ error: `Duplicate rendition: ${rendition}` }, { status: 400 })
    }
    seen.add(rendition)

    if (!mimeType || !Number.isFinite(size) || size <= 0) {
      return NextResponse.json({ error: 'Each rendition needs a mimeType and a positive size.' }, { status: 400 })
    }
    requests.push({ rendition: rendition as MediaRendition, mimeType, size })
  }

  // Tenant checks BEFORE minting any capability.
  //
  // RD-MEDIA-PERF-03: the gallery and album reads are independent, so they go together.
  // Serially this was two round trips on the critical path of EVERY photo.
  const [gallery, album] = await Promise.all([
    getOwnedGallery(galleryId, authz.workspaceUid),
    albumId ? getOwnedAlbum(albumId, authz.workspaceUid) : Promise.resolve(null),
  ])
  if (!gallery) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  if (albumId && (!album || album.galleryId !== galleryId)) {
    return NextResponse.json({ error: 'Album not found in this gallery' }, { status: 404 })
  }

  // ── RD-MEDIA-08: the effective limits for THIS event ───────────────────────
  // Event override → licence tier → global default — for upload SIZE and default visibility only.
  // RD-PHOTO-01: the photo COUNT is no longer a resolved limit. `maxPhotosPerEvent` grants nothing;
  // the event's paid photo capacity is decided by reservePhotoUpload below.
  const limits = await resolveMediaConfig({
    organizerUid: authz.workspaceUid,
    eventId:      gallery.eventId,
    eventSlug:    gallery.eventSlug,
  })

  // Largest stored rendition. The platform-storage policy still applies as an absolute
  // ceiling underneath — this can tighten it, never widen it past what storage accepts.
  const largest = requests.reduce((n, r) => Math.max(n, r.size), 0)
  const sizeVerdict = checkSize(largest, limits.maxUploadFileSizeBytes)
  if (!sizeVerdict.ok) {
    return NextResponse.json({ error: sizeVerdict.error }, { status: sizeVerdict.status })
  }

  const outcome = await prepareUploads({
    eventSlug: gallery.eventSlug,
    renditions: requests,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const assetId = newAssetId()

  // ── RD-MEDIA-04: record the reservation BEFORE handing out the capability ───
  // A `pending` record makes an abandoned upload a fact the reclamation sweep can find and
  // clean up (it used to mint signed URLs and write nothing, orphaning objects forever).
  //
  // ── RD-PHOTO-01: …and that reservation IS the photo-capacity decision ─────────
  // One transaction re-counts the event's pending + ready photos against its PAID capacity and
  // writes this reservation only if a unit is free. No paid capacity ⇒ 402 PHOTO_CAPACITY_REQUIRED;
  // full ⇒ 409 PHOTO_CAPACITY_FULL. Concurrent uploads (tabs, devices, parallel slots) serialise
  // on the event's lock document, so the event can never hold more photos than it paid for.
  // The signed URLs below are only returned once the reservation exists.
  const planned: Partial<Record<MediaRendition, RenditionRecord>> = {}
  for (const r of outcome.renditions) {
    planned[r.rendition] = {
      // RD-MEDIA-SIZE-01 — the DECLARED size is recorded on the reservation, so /complete can
      // refuse an object whose real size differs from what was authorised here.
      path: r.path, size: requests.find(q => q.rendition === r.rendition)?.size ?? 0,
      mimeType: r.mimeType, width: null, height: null,
    }
  }

  let reservation
  try {
    reservation = await reservePhotoUpload({
      assetId,
      organizerUid: authz.workspaceUid,
      eventId:      gallery.eventId,
      eventSlug:    gallery.eventSlug,
      galleryId,
      albumId,
      renditions:   planned,
      // RD-MEDIA-08: the RESOLVED default, so an event or plan override wins over the
      // workspace setting.
      visibility:   limits.defaultVisibility,
      uploadedBy:   authz.callerUid,
    })
  } catch (err) {
    // FAIL-CLOSED: no reservation (or no capacity decision) ⇒ no upload URL.
    console.error('[media-studio/uploads/prepare] reservation failed:', err)
    return NextResponse.json(
      { error: 'Could not start this upload. Please try again.' },
      { status: 503 },
    )
  }
  if (!reservation.ok) {
    return NextResponse.json(
      { error: reservation.error, code: reservation.code, capacity: reservation.figures },
      { status: reservation.status, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const body: PrepareUploadResponse = { assetId, renditions: outcome.renditions, sessionId: null }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
