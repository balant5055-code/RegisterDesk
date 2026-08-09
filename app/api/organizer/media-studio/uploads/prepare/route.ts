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
import {
  countEventAssets, newAssetId, reserveAsset,
} from '@/features/media-studio/repositories/assetRepo'
import { checkCount, checkSize, resolveMediaConfig } from '@/lib/config/resolveMediaConfig'
// MC-03 — Media Credits. Inert unless businessConfig.mediaStudio.creditsEnabled is true.
import { getCreditPolicy, ledgerService } from '@/features/media-credits/services'
import { openSession } from '@/features/media-credits/services/sessionService'
import { resolveSlot } from '@/features/media-credits/utils/sessionSlots'
import { InsufficientCreditsError, InvalidCreditOperationError } from '@/features/media-credits/errors'
import type { CreditSessionDto } from '@/features/media-credits/types'
import {
  isStorageReady, prepareUploads, type PreparedRendition, type RenditionRequest,
} from '@/features/media-studio/services/uploadService'
import {
  MEDIA_RENDITIONS, type MediaRendition, type RenditionRecord,
} from '@/features/media-studio/types'

export interface PrepareUploadResponse {
  assetId:    string
  renditions: PreparedRendition[]
  /** MC-06B. Null when credits are disabled. */
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

  // MC-06B session addressing. Absent when credits are disabled; required when enabled.
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const slotIndex = typeof raw.slotIndex === 'number' ? Math.trunc(raw.slotIndex) : null
  const sessionSlots = typeof raw.sessionSlots === 'number' ? Math.trunc(raw.sessionSlots) : null

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
  // Event override → licence tier → global default, resolved in one place. Nothing below
  // knows what any of the numbers are.
  //
  // RD-MEDIA-PERF-03: resolved alongside the event's photo count. Both are needed before any
  // capability is minted and neither depends on the other, so they overlap.
  const [limits, used] = await Promise.all([
    resolveMediaConfig({
      organizerUid: authz.workspaceUid,
      eventId:      gallery.eventId,
      eventSlug:    gallery.eventSlug,
    }),
    countEventAssets(authz.workspaceUid, gallery.eventId),
  ])

  // Largest stored rendition. The platform-storage policy still applies as an absolute
  // ceiling underneath — this can tighten it, never widen it past what storage accepts.
  const largest = requests.reduce((n, r) => Math.max(n, r.size), 0)
  const sizeVerdict = checkSize(largest, limits.maxUploadFileSizeBytes)
  if (!sizeVerdict.ok) {
    return NextResponse.json({ error: sizeVerdict.error }, { status: sizeVerdict.status })
  }

  // Photos already in this event, across every gallery (resolved above, in parallel).
  const countVerdict = checkCount(used, 1, limits.maxPhotosPerEvent, 'photos')
  if (!countVerdict.ok) {
    return NextResponse.json({ error: countVerdict.error }, { status: countVerdict.status })
  }

  // ── Media Credits — session-scoped (MC-06B, Spec v1.0 §11) ──────────────────
  // Fail-safe OFF. With `creditsEnabled` false this block resolves one config section and
  // returns — no session, no wallet read, no reservation, no behaviour change of any kind.
  // That is the backward-compatibility guarantee, and it is why the flag is checked first.
  const creditPolicy = await getCreditPolicy()

  let creditSession: CreditSessionDto | null = null
  let slotAssetId: string | null = null

  if (creditPolicy.creditsEnabled) {
    if (!sessionId || slotIndex === null) {
      // Fail closed. An upload without a slot has no allocation behind it, and issuing a
      // signed URL for one would be an unpaid upload.
      return NextResponse.json(
        { error: 'sessionId and slotIndex are required when media credits are enabled.' },
        { status: 400 },
      )
    }

    // Open-or-reuse. `openSession` is idempotent on the caller-supplied id, so the first
    // photo of a batch opens the session and every later one collides harmlessly on
    // `tx.create` and gets the existing allocation back. No separate open endpoint is needed.
    try {
      creditSession = await openSession({
        sessionId,
        organizerUid: authz.workspaceUid,
        eventId:      gallery.eventId,
        eventSlug:    gallery.eventSlug,
        galleryId,
        slotCount:    sessionSlots ?? 1,
        actorUid:     authz.callerUid,
      })
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return NextResponse.json(
          { error: err.message, code: err.code, required: err.required, available: err.available },
          { status: 402 },
        )
      }
      if (err instanceof InvalidCreditOperationError) {
        return NextResponse.json({ error: err.message, code: err.code }, { status: 400 })
      }
      console.error('[media-studio/uploads/prepare] session open failed:', err)
      return NextResponse.json(
        { error: 'Could not start this upload. Please try again.' },
        { status: 503 },
      )
    }

    if (creditSession.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'This upload session is no longer accepting photos.', code: 'SESSION_NOT_ACTIVE' },
        { status: 409 },
      )
    }

    // ── Stateless slot bound (Spec §11) ──
    // Arithmetic only: no counter is read and none is written. Over-consumption is impossible
    // because a slot outside the allocation never yields an assetId.
    const slot = resolveSlot(sessionId, slotIndex, creditSession.slotCount)
    if (!slot.ok) {
      return NextResponse.json(
        { error: `Invalid upload slot (${slot.reason}).`, code: 'INVALID_SLOT' },
        { status: 400 },
      )
    }
    slotAssetId = slot.assetId
  }

  const outcome = await prepareUploads({
    eventSlug: gallery.eventSlug,
    renditions: requests,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  // With credits on, the assetId is DERIVED from the slot rather than random — that is what
  // makes a retried prepare land on the same reservation document and be recognised as a
  // replay instead of claiming a second slot.
  const assetId = slotAssetId ?? newAssetId()

  // ── RD-MEDIA-04: record the reservation BEFORE handing out the capability ───
  // This route used to mint signed PUT URLs and write nothing. If the browser then PUT some
  // bytes and the tab closed, the objects sat in the bucket with NO record anywhere —
  // invisible to the dashboard, invisible to the organizer, billable forever, and
  // unfindable because nothing knew their keys.
  //
  // A `pending` record makes an abandoned upload a fact the reclamation sweep can find and
  // clean up. It moves no counter: a reservation is not a photo.
  const planned: Partial<Record<MediaRendition, RenditionRecord>> = {}
  for (const r of outcome.renditions) {
    planned[r.rendition] = {
      path: r.path, size: 0, mimeType: r.mimeType, width: null, height: null,
    }
  }

  try {
    await reserveAsset({
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
    // FAIL-CLOSED. If the reservation cannot be written, the upload URLs must not be issued:
    // handing out a capability whose objects nothing can ever find is exactly the hole this
    // reservation closes.
    console.error('[media-studio/uploads/prepare] reservation failed:', err)
    return NextResponse.json(
      { error: 'Could not start this upload. Please try again.' },
      { status: 503 },
    )
  }

  // ── Claim the session slot (MC-06B) ─────────────────────────────────────────
  // AFTER the asset reservation, so a slot claim can never outlive the record it belongs to.
  //
  // ═══ NO WALLET, NO LEDGER, NO BALANCE CHECK ══════════════════════════════════
  // This used to hold credits per photo, which meant reading and writing one wallet document
  // on every upload — the measured bottleneck (MC-05.6C: 3.14 photos/s across four instances,
  // p95 15–19s). The credits are already held by the session, so all that remains is creating
  // a document this slot alone owns. Two instances uploading for one organizer now write
  // nothing in common.
  //
  // Still FAIL-CLOSED: if the slot cannot be claimed, no signed URL is issued.
  if (creditSession) {
    try {
      await ledgerService.reserve({
        organizerUid: authz.workspaceUid,
        assetId,
        eventId:      gallery.eventId,
        eventSlug:    gallery.eventSlug,
        galleryId,
        // Recorded for audit and used by settlement's per-slot cost; it drives no wallet write.
        credits:      creditSession.creditsPerPhotoAtOpen,
        sessionId:    creditSession.sessionId,
        slotIndex:    slotIndex as number,
        actorUid:     authz.callerUid,
      })
    } catch (err) {
      if (err instanceof InvalidCreditOperationError) {
        // The slot is already spent — a retry against a consumed or released position.
        return NextResponse.json({ error: err.message, code: err.code }, { status: 409 })
      }
      console.error('[media-studio/uploads/prepare] slot claim failed:', err)
      return NextResponse.json(
        { error: 'Could not start this upload. Please try again.' },
        { status: 503 },
      )
    }
  }

  const body: PrepareUploadResponse = {
    assetId, renditions: outcome.renditions,
    sessionId: creditSession?.sessionId ?? null,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
