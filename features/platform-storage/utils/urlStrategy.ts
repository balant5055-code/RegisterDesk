// RD-STORAGE-01 · How an object's URL is produced. (Added RD-MEDIA-07.)
//
// PURE. No SDK, no I/O.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// `StorageService.resolveUrl` maps PUBLIC → the durable public URL. That URL requires
// `R2_PUBLIC_URL`, which is OPTIONAL by design (RD-STORAGE-01: "a bucket with no public
// domain is a valid setup — every object is then private or signed, which is the stricter
// posture").
//
// So on a deployment with no public domain, `resolveUrl` THROWS `NOT_CONFIGURED` for every
// PUBLIC object — and both media surfaces caught that and rendered a placeholder. The photo
// existed, the metadata was right, and nothing could display it.
//
// A PUBLIC object with no public domain is still perfectly servable: it can be SIGNED, using
// the same credentials every other operation uses. This decides that, in one place, so the
// organizer browser and the public gallery cannot disagree about it.
// ══════════════════════════════════════════════════════════════════════════════

import type { StorageVisibility } from '@/features/platform-storage/types'

/**
 * `public` — durable, CDN-cacheable. Preferred whenever it is available.
 * `signed` — short-lived. Correct for gated objects, and the FALLBACK for a public object
 *            on a bucket with no public domain.
 * `none`   — a PRIVATE object has no URL. Fetch it server-side.
 */
export type UrlStrategy = 'public' | 'signed' | 'none'

/**
 * Which kind of URL to produce.
 *
 * `hasPublicBaseUrl` is a DEPLOYMENT fact, not a per-object one — pass
 * `storage.publicUrl(path) !== null`, or the provider's configuration directly.
 */
export function resolveUrlStrategy(
  visibility: StorageVisibility, hasPublicBaseUrl: boolean,
): UrlStrategy {
  // A private object is never addressable by URL, however the bucket is configured.
  if (visibility === 'PRIVATE') return 'none'

  // Explicitly gated: always short-lived, even if a public domain exists. Serving one from a
  // durable public URL would silently un-gate it.
  if (visibility === 'SIGNED_URL') return 'signed'

  // PUBLIC: the durable URL when the bucket can produce one, otherwise a signature. Falling
  // back is strictly better than showing nothing — the object is public either way; only its
  // cacheability differs.
  return hasPublicBaseUrl ? 'public' : 'signed'
}

/**
 * True when falling back costs cacheability.
 *
 * Worth logging ONCE per deployment rather than per request: it means every public image is
 * being signed, which works but defeats the CDN and is almost always a missing
 * `R2_PUBLIC_URL` rather than an intentional posture.
 */
export function isDegradedPublicUrl(
  visibility: StorageVisibility, hasPublicBaseUrl: boolean,
): boolean {
  return visibility === 'PUBLIC' && !hasPublicBaseUrl
}
