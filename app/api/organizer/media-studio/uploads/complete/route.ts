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
import { registerAsset, serializeAsset } from '@/features/media-studio/repositories/assetRepo'
// MC-03 — Media Credits. Inert unless businessConfig.mediaStudio.creditsEnabled is true.
import { getCreditPolicy, consumeInTx } from '@/features/media-credits/services'
import { InvalidCreditOperationError, SessionNotActiveError } from '@/features/media-credits/errors'
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

  // Resolved once, before the write. With credits off this is the only extra work the
  // completion path performs — one cached config read, no wallet and no reservation touched.
  const creditsOn = (await getCreditPolicy()).creditsEnabled

  // ── MC-06B: the slot transition rides the asset write ───────────────────────
  // `consumeInTx` runs INSIDE `registerAsset`'s transaction, so the asset record and the
  // reservation's move to `consumed` commit together or not at all. It also reads the
  // session there, which is what arms the seal barrier — see the catch below.
  //
  // No wallet and no ledger are touched: the credits were held when the session opened, and
  // the balance moves once, at settlement.
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
  }, {
    // ── MC-03: consume the credit hold ATOMICALLY with the asset write ────────
    //
    // `beforeCommit` runs inside `registerAsset`'s own transaction, so the debit, the ledger
    // entry, the reservation transition and the asset record commit together — or none of
    // them do. Two separate transactions would leave a window in which the organizer is
    // charged for a photo that was never registered, and the sweep would then purge the
    // asset while the reservation stayed `consumed`, silently losing the credit.
    //
    // Undefined when credits are off, so the hook is not merely a no-op — it is absent, and
    // `registerAsset` takes exactly the path it took before MC-03.
    beforeCommit: creditsOn
      ? tx => consumeInTx(tx, {
          organizerUid: authz.workspaceUid,
          assetId,
          actorUid:     authz.callerUid,
        })
      : undefined,
  })

  // MC-06B removed the per-organizer queue. It existed only to serialise contention on the
  // wallet document, and the wallet is no longer on this path — `consumeInTx` now writes just
  // the reservation. Serialising uploads that share nothing would be pure lost throughput.
  let asset: Awaited<ReturnType<typeof registerAsset>>
  try {
    asset = await runRegister()
  } catch (err) {
    // ── The seal barrier fired (Spec v1.0 §6) ──
    // The session was sealed while this completion was in flight, so Firestore aborted the
    // whole transaction: no asset registered, no slot consumed, nothing partially committed.
    // A race, not a fault — 409 so the client can surface it as "this batch was closed"
    // rather than as a server error.
    if (err instanceof SessionNotActiveError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
    }
    if (err instanceof InvalidCreditOperationError) {
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
