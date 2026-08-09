// RD-MEDIA-01 · Upload orchestration — SERVER ONLY.
//
// ─── How bytes actually move, and why ────────────────────────────────────────
// The server MINTS a presigned PUT URL per rendition; the browser PUTs the bytes straight
// to object storage. No image byte passes through this application.
//
// That is a deliberate reading of "uploads must occur through server-side infrastructure":
// the SERVER decides the key, authorizes the caller, validates the type and size, and
// issues the signature — a browser cannot upload anything the server did not authorize,
// because it has no credentials. What the server does not do is act as a byte relay, which
// at "thousands of photos" would be both a bottleneck and, on a serverless deployment, an
// outright 4.5 MB body-limit failure.
//
// Everything goes through `@/features/platform-storage`. This module never names Cloudflare
// R2 and never imports an S3 SDK.

import {
  StorageError, storage,
  assertMimeAllowed, assertSizeAllowed, buildObjectKey, generateObjectId,
  isDegradedPublicUrl, resolveUrlStrategy,
  type StorageAssetType,
} from '@/features/platform-storage'
import { UPLOAD_URL_TTL_SECONDS, type MediaRendition } from '@/features/media-studio/types'

/** Which storage asset type backs each rendition. */
const RENDITION_ASSET_TYPE: Readonly<Record<MediaRendition, StorageAssetType>> = {
  original:  'event-photo-original',
  medium:    'event-photo-medium',
  thumbnail: 'event-photo-thumbnail',
}

// RD-MS-HOTFIX-01 · UPLOAD_URL_TTL_SECONDS moved to ../types (a module with no imports).
// Re-exported so every existing importer of this service keeps working unchanged.
export { UPLOAD_URL_TTL_SECONDS }

/** Renditions requested per photo in one prepare call. */
export interface RenditionRequest {
  rendition: MediaRendition
  mimeType:  string
  size:      number
}

export interface PreparedRendition {
  rendition: MediaRendition
  /** Object KEY the browser must PUT to. Recorded verbatim on completion. */
  path:      string
  uploadUrl: string
  mimeType:  string
}

export type PrepareOutcome =
  | { ok: true;  renditions: PreparedRendition[] }
  | { ok: false; status: number; error: string }

/**
 * Validates and issues one signed PUT URL per rendition.
 *
 * Validation runs BEFORE any URL is minted, so a disallowed type or an oversized file never
 * receives an upload capability at all. `assertMimeAllowed` is the platform-storage
 * allow-list: SVG, HTML and JavaScript are refused there, for every asset type.
 */
export async function prepareUploads(params: {
  eventSlug:  string
  renditions: readonly RenditionRequest[]
}): Promise<PrepareOutcome> {
  const { eventSlug, renditions } = params

  if (renditions.length === 0) {
    return { ok: false, status: 400, error: 'No renditions requested.' }
  }

  const prepared: PreparedRendition[] = []

  try {
    for (const req of renditions) {
      const assetType = RENDITION_ASSET_TYPE[req.rendition]
      if (!assetType) {
        return { ok: false, status: 400, error: `Unknown rendition: ${req.rendition}` }
      }

      // Type + size are enforced by the platform layer's per-asset-type policy.
      const mimeType = assertMimeAllowed(assetType, req.mimeType)
      assertSizeAllowed(assetType, req.size)

      // The key is generated here, server-side. The browser never chooses a path, so it
      // cannot write outside its event's prefix even with a valid signature.
      const objectId = generateObjectId(mimeType)
      const path = buildObjectKey({ type: assetType, eventSlug, objectId })

      const uploadUrl = await storage.generateSignedUrl({
        path, operation: 'write', mimeType, expiresIn: UPLOAD_URL_TTL_SECONDS,
      })

      prepared.push({ rendition: req.rendition, path, uploadUrl, mimeType })
    }
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

  return { ok: true, renditions: prepared }
}

/**
 * Best-effort removal of objects for an asset that was deleted or abandoned.
 *
 * Never throws: a failed cleanup must not fail the user's delete. It leaves an orphaned
 * object, which costs storage but breaks nothing — the opposite trade (failing the delete)
 * would leave the organizer unable to remove a photo at all.
 */
export async function removeObjects(paths: readonly string[]): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed  = 0

  for (const path of paths) {
    try {
      await storage.delete(path)
      removed++
    } catch {
      failed++
    }
  }

  return { removed, failed }
}

/** How long a fallback signature lasts. Long enough to browse a gallery, short enough that
 *  a copied URL stops working. */
const FALLBACK_SIGNED_URL_TTL_SECONDS = 3600   // 1 hour

/** Logged once per process, not per image — see `isDegradedPublicUrl`. */
let warnedAboutMissingPublicUrl = false

/**
 * THE viewable URL for one rendition. Every media surface uses this one function.
 *
 * ─── RD-MEDIA-07: why this is not just `resolveUrl` ──────────────────────────
 * It used to be. `resolveUrl` maps PUBLIC → the durable public URL, which needs
 * `R2_PUBLIC_URL` — OPTIONAL by design (RD-STORAGE-01). On a bucket with no public domain it
 * therefore THREW for every public object, this function swallowed the error, and every
 * caller got `null`:
 *
 *   • the upload response returned `thumbnailUrl: null`
 *   • the organizer gallery browser showed "No preview"
 *   • the public gallery showed a placeholder
 *
 * The photo existed and was correct in all three cases. A public object with no public
 * domain is still perfectly servable — it can be SIGNED with the same credentials — so it
 * now is. The strategy lives in `resolveUrlStrategy` so the two surfaces cannot disagree.
 */
export async function resolveRenditionUrl(
  path: string,
  visibility: 'PUBLIC' | 'PRIVATE' | 'SIGNED_URL',
): Promise<string | null> {
  try {
    const hasPublicBaseUrl = storage.publicUrl(path) !== null
    const strategy = resolveUrlStrategy(visibility, hasPublicBaseUrl)

    if (strategy === 'none') return null

    if (isDegradedPublicUrl(visibility, hasPublicBaseUrl) && !warnedAboutMissingPublicUrl) {
      warnedAboutMissingPublicUrl = true
      console.warn(
        '[media-studio] R2_PUBLIC_URL is not set, so every public image is being signed. '
        + 'This works, but the URLs cannot be cached by a CDN. Set R2_PUBLIC_URL to serve '
        + 'public photos from a durable, cacheable address.',
      )
    }

    if (strategy === 'public') return storage.publicUrl(path)

    return await storage.generateSignedUrl({
      path, operation: 'read', expiresIn: FALLBACK_SIGNED_URL_TTL_SECONDS,
    })
  } catch (err) {
    // Storage is unreachable or unconfigured entirely. A gallery listing degrades to a
    // placeholder rather than failing — but it is LOGGED, because the silent version of
    // this is what hid the missing public URL for two sprints.
    console.error('[media-studio] could not resolve a rendition URL:', { path, visibility, err })
    return null
  }
}

/** Whether storage is usable at all — surfaced so the UI can explain a cold failure. */
export function isStorageReady(): boolean {
  return storage.isConfigured()
}
