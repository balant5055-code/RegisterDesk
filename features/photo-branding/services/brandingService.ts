// RD-PHOTO-01 · Branding overlay — SERVER ONLY.
//
// ═══ REUSE, NOT A SECOND PIPELINE ═════════════════════════════════════════════
// Upload follows the pattern Media Studio already uses (RD-MEDIA-01): the server validates,
// chooses the key and mints a presigned PUT; the browser sends the bytes straight to object
// storage. Nothing here relays bytes, imports an S3 SDK, or names Cloudflare R2.
//
// The key comes from `buildObjectKey`, the type and size policy from `assertMimeAllowed` /
// `assertSizeAllowed` — the platform's PNG-only, 2 MB rule for `event-branding-overlay`. So
// "PNG only" is enforced at the storage boundary, not merely in the UI.
// ══════════════════════════════════════════════════════════════════════════════

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  StorageError, storage, assertMimeAllowed, assertSizeAllowed, buildObjectKey,
  generateObjectId,
} from '@/features/platform-storage'
import { resolveRenditionUrl } from '@/features/media-studio/services/uploadService'
import { countEventAssets } from '@/features/media-studio/repositories/assetRepo'
// RD-MS-CLOSURE-01 · the platform branding switch. The EXISTING business-config service —
// no new configuration system, and the same reader every other module uses.
import { businessConfig } from '@/lib/config/businessConfigService'
import { DEFAULT_STYLE, isBrandingStyle, specFor } from '@/features/photo-branding/utils/artworkSpec'
import { describeBrandingLock, type BrandingLock } from '@/features/photo-branding/utils/brandingLock'
import {
  isBrandingIntent, resolveBrandingWorkflow,
  type BrandingIntent, type BrandingWorkflow,
} from '@/features/photo-branding/utils/brandingIntent'
import type { BrandingOverlayDoc, BrandingOverlayView, BrandingState } from '@/features/photo-branding/types'

const ASSET_TYPE = 'event-branding-overlay' as const

/** Short-lived, like every other upload capability the platform issues. */
export const UPLOAD_URL_TTL_SECONDS = 900

const settings = () => adminDb.collection('mediaSettings')

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function getOverlayDoc(
  organizerUid: string, eventId: string,
): Promise<BrandingOverlayDoc | null> {
  try {
    const snap = await settings().doc(organizerUid).get()
    if (!snap.exists) return null
    const map = snap.get('branding') as Record<string, BrandingOverlayDoc> | undefined
    return map?.[eventId] ?? null
  } catch {
    return null
  }
}

/**
 * The client-facing state.
 *
 * The URL is resolved through the SHARED resolver (RD-MEDIA-07), so an overlay renders on a
 * bucket with no public domain exactly as a photo does — public URL when one exists, signed
 * otherwise. Never a raw key.
 */
export async function getBrandingState(
  organizerUid: string, eventId: string,
): Promise<BrandingState> {
  const doc = await getOverlayDoc(organizerUid, eventId)
  if (!doc) return { overlay: null, active: false }

  const url = await resolveRenditionUrl(doc.path, 'PUBLIC')
  if (!url) return { overlay: null, active: false }

  const overlay: BrandingOverlayView = {
    url,
    width:  doc.width,
    height: doc.height,
    bytes:  doc.bytes,
    style:  isBrandingStyle(doc.style) ? doc.style : DEFAULT_STYLE,
    enabled: doc.enabled !== false,
    uploadedAt: doc.uploadedAt,
    updatedAt:  doc.updatedAt,
  }

  return { overlay, active: overlay.enabled }
}

/**
 * RD-PHOTO-03 · Whether branding may still be changed.
 *
 * Branding is baked into pixels at import, so once an event has photos the artwork is
 * settled — see `describeBrandingLock` for why refusing is the honest answer.
 *
 * The rule itself is PURE and unit-tested; this function only supplies the count. The count
 * is the same aggregate the upload limit already uses, so this adds no new query shape and
 * no index.
 */
export async function getBrandingLock(
  organizerUid: string, eventId: string,
): Promise<BrandingLock> {
  return describeBrandingLock(await countEventAssets(organizerUid, eventId))
}

// ─── The per-event decision (RD-PHOTO-04) ─────────────────────────────────────

/**
 * The organizer's recorded choice, or null if they have never been asked.
 *
 * A SIBLING map to `branding`, on the same document. It has to exist independently of the
 * artwork: "I want branding" must be expressible before any PNG has been uploaded, which
 * is exactly the state the old model could not represent.
 */
export async function getBrandingIntent(
  organizerUid: string, eventId: string,
): Promise<BrandingIntent | null> {
  try {
    const snap = await settings().doc(organizerUid).get()
    if (!snap.exists) return null
    const map = snap.get('brandingIntent') as Record<string, unknown> | undefined
    const value = map?.[eventId]
    return isBrandingIntent(value) ? value : null
  } catch {
    // Unreadable reads as "never asked". That errs toward showing the question again,
    // which is recoverable — silently importing under a decision we could not read is not.
    return null
  }
}

/**
 * Records the decision, and keeps the overlay's `enabled` flag in step with it.
 *
 * Syncing `enabled` is what keeps this OUT of the upload pipeline: `useUploadQueue` still
 * brands when there is an enabled overlay, exactly as before. The decision changes what
 * that flag says; it does not add a second condition the pipeline has to consult.
 */
export async function setBrandingIntent(
  organizerUid: string, eventId: string, intent: BrandingIntent,
): Promise<void> {
  const ref = settings().doc(organizerUid)
  await ref.set({ organizerUid, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  // Targeted field path, never the whole map — a stale tab must not wipe another event's
  // decision (the hazard `eventLimitOverrides` and `branding` both guard against).
  await ref.update({
    [`brandingIntent.${eventId}`]: intent,
    updatedAt: FieldValue.serverTimestamp(),
  })

  const doc = await getOverlayDoc(organizerUid, eventId)
  if (!doc) return
  const enabled = intent === 'branded'
  if (doc.enabled === enabled) return
  await writeBranding(organizerUid, eventId, {
    ...doc, enabled, updatedAt: new Date().toISOString(),
  })
}

/**
 * THE resolved state, for every surface.
 *
 * Import, the branding page, the hub card and the gallery badge all render from this one
 * object, so they cannot disagree about an event.
 */
export async function getBrandingWorkflow(
  organizerUid: string, eventId: string,
): Promise<BrandingWorkflow> {
  const [doc, intent, photoCount, brandingSwitch] = await Promise.all([
    getOverlayDoc(organizerUid, eventId),
    getBrandingIntent(organizerUid, eventId),
    countEventAssets(organizerUid, eventId),
    businessConfig.getValue('mediaStudio', 'brandingEnabled'),
  ])

  // ═══ RD-MS-CLOSURE-01 · the platform switch ══════════════════════════════
  // Applied HERE because `resolveBrandingWorkflow` is the ONE decision every branding
  // surface reads — the Branding page, the import gate and the gallery badge all render
  // from its answer. Switching the platform off therefore turns branding off everywhere at
  // once, with no second rule to keep in step.
  //
  // Modelled as "the overlay is not enabled" rather than as a new state: an organizer whose
  // artwork exists but cannot be applied is in exactly the situation `overlayEnabled: false`
  // already describes, and the workflow already handles it correctly — `required` blocks the
  // import rather than importing unbranded photos the organizer expected to be branded.
  //
  // Existing photos are untouched, and must be: their overlay is baked into stored bytes.
  const brandingAllowed = brandingSwitch !== false

  return resolveBrandingWorkflow({
    intent,
    hasOverlay:     Boolean(doc),
    overlayEnabled: brandingAllowed && (doc ? doc.enabled !== false : false),
    photoCount,
  })
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export type PrepareOutcome =
  | { ok: true;  path: string; uploadUrl: string }
  | { ok: false; status: number; error: string }

/**
 * Validates and issues ONE signed PUT for the overlay.
 *
 * Validation runs before any URL exists, so a disallowed type or an oversized file never
 * receives an upload capability at all.
 */
export async function prepareOverlayUpload(params: {
  eventSlug: string
  mimeType:  string
  bytes:     number
}): Promise<PrepareOutcome> {
  try {
    const mimeType = assertMimeAllowed(ASSET_TYPE, params.mimeType)
    assertSizeAllowed(ASSET_TYPE, params.bytes)

    // Server-chosen key. A new object id on every upload rather than a fixed name, so
    // replacing artwork can never be served stale from a CDN that cached the old one.
    const objectId = generateObjectId(mimeType)
    const path = buildObjectKey({ type: ASSET_TYPE, eventSlug: params.eventSlug, objectId })

    const uploadUrl = await storage.generateSignedUrl({
      path, operation: 'write', mimeType, expiresIn: UPLOAD_URL_TTL_SECONDS,
    })

    return { ok: true, path, uploadUrl }
  } catch (err) {
    if (err instanceof StorageError) {
      const status = err.code === 'FILE_TOO_LARGE' ? 413
        : err.code === 'UNSUPPORTED_TYPE' ? 415
        : err.code === 'NOT_CONFIGURED' ? 503
        : 400
      return { ok: false, status, error: err.message }
    }
    throw err
  }
}

/**
 * Records the overlay after its bytes are confirmed in the bucket.
 *
 * The size is taken FROM STORAGE, never from the client's claim — the same discipline
 * `/uploads/complete` uses for photos. A caller cannot understate a 10 MB file into the 2 MB
 * allowance.
 *
 * Replacing an overlay deletes the previous object best-effort. A failure there leaves an
 * orphan, which costs storage and breaks nothing; failing the replacement would leave the
 * organizer unable to change their branding.
 */
export async function saveOverlay(params: {
  organizerUid: string
  eventId:      string
  path:         string
  width:        number
  height:       number
  uploadedBy:   string
}): Promise<{ ok: true; doc: BrandingOverlayDoc } | { ok: false; status: number; error: string }> {
  let meta
  try {
    meta = await storage.getMetadata(params.path)
  } catch {
    return {
      ok: false, status: 409,
      error: 'The artwork was not found in storage. The upload did not complete.',
    }
  }

  const spec = specFor(DEFAULT_STYLE)
  if (meta.size > spec.maxBytes) {
    return { ok: false, status: 413, error: 'That artwork is larger than the limit allows.' }
  }

  const previous = await getOverlayDoc(params.organizerUid, params.eventId)
  const now = new Date().toISOString()

  const doc: BrandingOverlayDoc = {
    path:      params.path,
    mimeType:  meta.mimeType,
    bytes:     meta.size,
    width:     params.width,
    height:    params.height,
    style:     DEFAULT_STYLE,
    // A replacement keeps whatever the organizer had chosen; a first upload arrives enabled,
    // because uploading branding is the act of asking for it.
    enabled:   previous ? previous.enabled : true,
    uploadedBy: params.uploadedBy,
    uploadedAt: previous?.uploadedAt ?? now,
    updatedAt:  now,
  }

  await writeBranding(params.organizerUid, params.eventId, doc)

  if (previous && previous.path !== params.path) {
    await storage.delete(previous.path).catch(() => { /* orphan, not a failure */ })
  }

  return { ok: true, doc }
}

/** Turns branding on or off without touching the artwork. */
export async function setEnabled(
  organizerUid: string, eventId: string, enabled: boolean,
): Promise<boolean> {
  const doc = await getOverlayDoc(organizerUid, eventId)
  if (!doc) return false
  await writeBranding(organizerUid, eventId, { ...doc, enabled, updatedAt: new Date().toISOString() })
  return true
}

/** Removes the record and, best-effort, the object. */
export async function removeOverlay(organizerUid: string, eventId: string): Promise<boolean> {
  const doc = await getOverlayDoc(organizerUid, eventId)
  if (!doc) return false

  await settings().doc(organizerUid).update({
    [`branding.${eventId}`]: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  await storage.delete(doc.path).catch(() => { /* orphan, not a failure */ })
  return true
}

/**
 * A targeted field-path write.
 *
 * Never the whole `branding` map: a stale tab saving all of it would wipe every other
 * event's overlay — the same hazard `eventLimitOverrides` guards against (RD-MEDIA-09).
 */
async function writeBranding(
  organizerUid: string, eventId: string, doc: BrandingOverlayDoc,
): Promise<void> {
  const ref = settings().doc(organizerUid)
  // `set` with merge first: the settings document legitimately may not exist yet, and
  // uploading branding must not require having saved settings.
  await ref.set({ organizerUid, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  await ref.update({
    [`branding.${eventId}`]: doc,
    updatedAt: FieldValue.serverTimestamp(),
  })
}
