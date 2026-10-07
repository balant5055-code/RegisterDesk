// POST /api/organizer/media-studio/uploads/complete
//
// Registers ONE finished photo's metadata after the browser has PUT every rendition.
//
// The server VERIFIES the bytes landed rather than trusting the client's word: each
// rendition's key is checked with a HEAD through StorageService, and the reported size must
// match what is actually in the bucket. A client claiming an upload it never made cannot
// inflate a gallery's counters.
//
// Idempotent: the assetId comes from /prepare, so a retried call after a dropped response
// overwrites the same record and nets the counters out.

import { NextRequest, NextResponse } from 'next/server'
import { storage } from '@/features/platform-storage'
import { authorizeMedia } from '@/features/media-studio/services/authorize'
import { getOwnedAlbum, getOwnedGallery } from '@/features/media-studio/repositories/galleryRepo'
import { registerAsset, serializeAsset, UnreservedAssetError } from '@/features/media-studio/repositories/assetRepo'
import { resolveRenditionUrl } from '@/features/media-studio/services/uploadService'
// RD-MS-CLOSURE-01 · ONE configuration source for the upload path.
//
// This route used to read `defaultVisibility` from the organizer's `mediaSettings` document
// through `getSettings`. That was a SECOND source of truth: the same key is a
// `MediaDefaultsConfig` field, resolvable global → plan → event through the resolver, offered
// in `EventOverridesPanel` and displayed as effective in `MediaLimitsPanel`.
//
// The two never met. An organizer who set an event to SIGNED_URL saw the override accepted,
// stored and rendered — and every photo still landed PUBLIC. A privacy control that reports
// success and does nothing is worse than one that is absent.
import { resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
import { enqueueableKinds, isAutoAnalyzeOnUpload, tryEnqueueAsset } from '@/features/ai'
import {
  MEDIA_RENDITIONS, type MediaAssetView, type MediaRendition, type RenditionRecord,
} from '@/features/media-studio/types'

export interface CompleteUploadResponse { asset: MediaAssetView }

const isSha256 = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const assetId   = typeof raw.assetId   === 'string' ? raw.assetId.trim()   : ''
  const galleryId = typeof raw.galleryId === 'string' ? raw.galleryId.trim() : ''
  const albumId   = typeof raw.albumId   === 'string' && raw.albumId.trim() !== ''
    ? raw.albumId.trim() : null
  const profileId = typeof raw.profileId === 'string' ? raw.profileId.trim() : 'unknown'
  const checksum  = isSha256(raw.checksum) ? raw.checksum : ''
  const bytesOriginalSource = typeof raw.bytesOriginalSource === 'number'
    ? Math.max(0, Math.floor(raw.bytesOriginalSource)) : 0

  if (!assetId || !galleryId) {
    return NextResponse.json({ error: 'assetId and galleryId are required' }, { status: 400 })
  }
  if (!checksum) {
    return NextResponse.json({ error: 'A sha256 checksum of the original is required' }, { status: 400 })
  }
  if (!Array.isArray(raw.renditions) || raw.renditions.length === 0) {
    return NextResponse.json({ error: 'renditions[] is required' }, { status: 400 })
  }

  const gallery = await getOwnedGallery(galleryId, authz.workspaceUid)
  if (!gallery) return NextResponse.json({ error: 'Gallery not found' }, { status: 404 })

  if (albumId) {
    const album = await getOwnedAlbum(albumId, authz.workspaceUid)
    if (!album || album.galleryId !== galleryId) {
      return NextResponse.json({ error: 'Album not found in this gallery' }, { status: 404 })
    }
  }

  // RD-MS-CLOSURE-01 · the SAME resolver every other upload route uses (`prepare`,
  // `duplicates`, `galleries`, `albums`). The gallery is already loaded above and carries the
  // event, so resolving costs no read this route was not already making.
  const mediaConfig = await resolveMediaConfig({
    organizerUid: authz.workspaceUid,
    eventId:      gallery.eventId,
    eventSlug:    gallery.eventSlug,
  })

  // ── Verify every rendition actually exists, and take its size from the BUCKET ──
  const renditions: Partial<Record<MediaRendition, RenditionRecord>> = {}
  let bytesStored = 0
  let width:  number | null = null
  let height: number | null = null
  let mimeType = 'image/jpeg'

  // ── Validate every claim BEFORE touching the network ──
  // Cheap, synchronous and fail-fast: a malformed or out-of-tenant path must be rejected
  // without having issued a single storage request.
  const claims: { rendition: MediaRendition; path: string; w: number | null; h: number | null }[] = []
  for (const entry of raw.renditions) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ error: 'Malformed rendition.' }, { status: 400 })
    }
    const r = entry as Record<string, unknown>
    const rendition = typeof r.rendition === 'string' ? r.rendition : ''
    const path      = typeof r.path === 'string' ? r.path : ''

    if (!(MEDIA_RENDITIONS as readonly string[]).includes(rendition) || !path) {
      return NextResponse.json({ error: 'Malformed rendition.' }, { status: 400 })
    }

    // The key must sit under THIS event's prefix. A signed URL is scoped to one key, but
    // this stops a caller registering someone else's object into their own gallery.
    if (!path.startsWith(`events/${gallery.eventSlug}/`)) {
      return NextResponse.json({ error: 'Rendition path does not belong to this event.' }, { status: 400 })
    }

    claims.push({
      rendition: rendition as MediaRendition,
      path,
      w: typeof r.width  === 'number' ? Math.floor(r.width)  : null,
      h: typeof r.height === 'number' ? Math.floor(r.height) : null,
    })
  }

  // ── RD-MEDIA-PERF-03: HEAD every rendition CONCURRENTLY ──
  // These were three sequential HeadObject round trips to object storage on the critical
  // path of every photo. They are independent keys; nothing ordered them.
  const metas = await Promise.all(claims.map(async c => {
    try {
      return { c, meta: await storage.getMetadata(c.path) }
    } catch {
      return { c, meta: null }
    }
  }))

  const missing = metas.find(m => m.meta === null)
  if (missing) {
    return NextResponse.json(
      { error: `The ${missing.c.rendition} image was not found in storage. The upload did not complete.` },
      { status: 409 },
    )
  }

  for (const { c, meta } of metas) {
    if (!meta) continue   // unreachable: the guard above returned
    renditions[c.rendition] = {
      path: c.path, size: meta.size, mimeType: meta.mimeType, width: c.w, height: c.h,
    }
    bytesStored += meta.size
    if (c.rendition === 'original') { width = c.w; height = c.h; mimeType = meta.mimeType }
  }

  // RD-PHOTO-01 — the photo's unit of paid event capacity was taken at /uploads/prepare, together
  // with its `pending` reservation. `registerAsset` only promotes THAT reservation (same organizer,
  // event and object keys) to `ready`; a completion without one is refused (UnreservedAssetError).
  // The organizer-level Media Credits consumption that used to ride this write is retired.
  const runRegister = () => registerAsset({
    assetId,
    organizerUid: authz.workspaceUid,
    eventId:      gallery.eventId,
    eventSlug:    gallery.eventSlug,
    galleryId,
    albumId,
    checksum,
    originalFilename: typeof raw.originalFilename === 'string'
      ? raw.originalFilename.slice(0, 200) : null,
    renditions,
    bytesStored,
    // Never below what was actually stored — a client under-reporting the source size would
    // otherwise manufacture a negative "space saved".
    bytesOriginalSource: Math.max(bytesOriginalSource, bytesStored),
    mimeType,
    width,
    height,
    profileId,
    // RD-MS-CLOSURE-01 · resolved global → plan → event, so a per-event override actually
    // reaches the photo it was set for.
    visibility: mediaConfig.defaultVisibility,
    uploadedBy: authz.callerUid,
  })

  let asset: Awaited<ReturnType<typeof registerAsset>>
  try {
    asset = await runRegister()
  } catch (err) {
    if (err instanceof UnreservedAssetError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
    }
    throw err
  }

  // ── RD-AI-01: hand the finished photo to the AI pipeline ────────────────────
  // This is the "Media Upload → AI Queue" edge, and it is INERT: `isAutoAnalyzeOnUpload()`
  // requires BOTH a configured provider (there is none) AND an explicit opt-in env flag, so
  // no job is created and no backlog of unrunnable work accumulates.
  //
  // FAIL-SOFT by construction: `tryEnqueueAsset` swallows its own failures and the whole
  // block is wrapped, because a photo upload must never fail because AI is unavailable.
  if (isAutoAnalyzeOnUpload()) {
    try {
      for (const kind of enqueueableKinds()) {
        await tryEnqueueAsset({
          organizerUid: authz.workspaceUid,
          eventId:      gallery.eventId,
          eventSlug:    gallery.eventSlug,
          assetId:      asset.assetId,
          galleryId:    asset.galleryId,
          albumId:      asset.albumId,
          kind,
          createdBy:    authz.callerUid,
        })
      }
    } catch (err) {
      console.error('[media-studio/uploads/complete] AI enqueue failed:', err)
    }
  }

  const thumb = asset.renditions.thumbnail ?? asset.renditions.medium ?? asset.renditions.original
  const thumbnailUrl = thumb ? await resolveRenditionUrl(thumb.path, asset.visibility) : null

  const body: CompleteUploadResponse = { asset: serializeAsset(asset, thumbnailUrl) }
  return NextResponse.json(body, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
