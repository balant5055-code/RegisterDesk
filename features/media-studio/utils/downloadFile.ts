'use client'

// RD-MEDIA-11 · Download a file instead of navigating to it.
//
// ═══ WHY THE `download` ATTRIBUTE IS NOT ENOUGH ═══════════════════════════════
// `<a href="/api/…/download" download>` looks like it should work, and does not.
//
// Our download routes are same-origin, but they 302-redirect to a presigned object-storage
// URL on another origin. The `download` attribute is IGNORED across an origin boundary — the
// browser drops the download intent and navigates instead. Because the object's Content-Type
// is `image/jpeg`, the browser then renders it. That is the reported bug: "the download icon
// opens the image in a new tab".
//
// Making the redirect target carry `Content-Disposition: attachment` would mean adding
// `response-content-disposition` to the presign — a StorageService change, which this
// refinement forbids.
//
// So the fetch happens in the page: ONE request to our own route, the bytes become a Blob,
// and a synthetic anchor pointing at an object URL downloads them. Same origin from the
// browser's point of view, so `download` is honoured and a filename can be set.
// ══════════════════════════════════════════════════════════════════════════════
//
// DOM-only. Never imported by a server module.

/** What happened, so a caller can tell the difference between a save and a fallback. */
export type DownloadOutcome = 'downloaded' | 'opened' | 'failed'

/**
 * Downloads a URL as a file.
 *
 * ONE fetch. The blob is used directly — nothing is requested twice, and the image the
 * visitor is looking at is not re-downloaded to display it.
 *
 * ─── The fallback, and when it fires ─────────────────────────────────────────
 * `fetch` follows our 302 to object storage. Reading that response requires the bucket to
 * allow this origin by CORS. If it does not, the fetch throws — and rather than leaving the
 * visitor with a dead icon, a plain anchor navigation is attempted so they still reach the
 * image. That is the pre-existing behaviour, reached only when the good path is unavailable,
 * and it is reported back as `'opened'` so the UI can say something honest.
 */
export async function downloadFile(url: string, filename: string): Promise<DownloadOutcome> {
  if (typeof window === 'undefined') return 'failed'

  try {
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`Download failed (${res.status})`)

    // RD-PHOTO-03: saved exactly as fetched. There is no transform step — branding is
    // already part of the stored photo, so nothing needs changing in flight.
    const objectUrl = URL.createObjectURL(await res.blob())

    try {
      triggerAnchor(objectUrl, filename)
    } finally {
      // Revoked on the next tick, not immediately: the click is dispatched synchronously but
      // the browser reads the object URL asynchronously, and revoking too early cancels the
      // save on some browsers.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
    }

    return 'downloaded'
  } catch {
    // The bucket does not permit a cross-origin read. Navigate rather than do nothing —
    // deliberately WITHOUT target="_blank", so at worst the visitor moves within their tab
    // and can come back, instead of accumulating orphan tabs.
    try {
      triggerAnchor(url, filename)
      return 'opened'
    } catch {
      return 'failed'
    }
  }
}

/** Clicks a detached anchor. Never added to the document flow, never focusable. */
function triggerAnchor(href: string, filename: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.rel = 'noopener'
  // Appended because Firefox ignores a click on an anchor that is not in the document.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/**
 * A filename for a downloaded photo.
 *
 * Derived from what the surface already knows — never from a storage key, which would leak
 * the bucket layout into a visitor's downloads folder.
 */
export function photoFilename(
  prefix: string, id: string, mimeType?: string | null,
): string {
  const extension = mimeType === 'image/png' ? 'png'
    : mimeType === 'image/webp' ? 'webp'
    : mimeType === 'image/avif' ? 'avif'
    : 'jpg'
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safePrefix || 'photo'}-${id.slice(-8)}.${extension}`
}
