// lib/events/galleryLimits.ts
// RD-GALLERY-01 — the event gallery's two limits, ONE definition for the wizard and the server.
// PURE + isomorphic (no Firebase, no DOM).
//
//   • images UPLOADED through the gallery's upload control: at most GALLERY_UPLOAD_MAX (6) per event
//   • images ADDED BY URL:                                   at most GALLERY_URL_MAX (20) per event
//
// The two are counted separately, so neither method inherits the other's limit.
//
// WHICH IS WHICH — an uploaded image is stored as `{ source: 'url', value: <storage URL> }` (the same
// shape as a pasted link), so the wizard now also records `origin: 'upload'`. That marker is a
// client claim, so the count does not depend on it alone: an image whose address is on the
// PLATFORM'S OWN STORAGE (Firebase Storage, or the R2 public host) can only have got there by being
// uploaded, and is counted as an upload whatever its marker says. A pasted link that happens to
// point at our storage therefore counts as an upload too — the conservative direction.
//
// EXISTING EVENTS are never broken: a change is refused only if it makes a count GROW past its limit
// (galleryChangeProblem), so a gallery saved under the old 20-upload limit can still be edited,
// reordered and trimmed — it just cannot grow while it is over.

export const GALLERY_UPLOAD_MAX = 6
export const GALLERY_URL_MAX    = 20

/** Client-side compression targets for uploaded gallery images. */
export const GALLERY_COMPRESSION = {
  maxDimension:  1920,              // longest side, px — aspect ratio preserved
  targetBytes:   400 * 1024,        // aim for ~200–400 KB
  maxBytes:      1024 * 1024,       // never upload a compressed image above 1 MB — refuse instead
  originalMaxBytes: 5 * 1024 * 1024, // the ORIGINAL file is still limited to 5 MB
  acceptedTypes: ['image/png', 'image/jpeg', 'image/webp'] as readonly string[],
} as const

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : {})

/** The platform's own storage hosts — where an UPLOADED gallery image lives. */
export function platformStorageHosts(): string[] {
  const hosts = ['firebasestorage.googleapis.com', 'storage.googleapis.com']
  // The R2 public host: inlined for the browser as NEXT_PUBLIC_R2_PUBLIC_HOST, read from
  // R2_PUBLIC_URL on the server. Either may be absent (no public R2 domain configured).
  const r2 = (process.env.NEXT_PUBLIC_R2_PUBLIC_HOST ?? '').trim()
  if (r2) hosts.push(r2.toLowerCase())
  const raw = (process.env.R2_PUBLIC_URL ?? '').trim()
  if (raw) { try { hosts.push(new URL(raw).hostname.toLowerCase()) } catch { /* not a URL — ignored */ } }
  return hosts
}

export function isPlatformStorageUrl(url: unknown, hosts: readonly string[] = platformStorageHosts()): boolean {
  if (typeof url !== 'string') return false
  try { return hosts.includes(new URL(url).hostname.toLowerCase()) } catch { return false }
}

/** 'upload' | 'url' for a gallery entry, or null for an empty one (not counted). */
export function galleryOrigin(asset: unknown, hosts: readonly string[] = platformStorageHosts()): 'upload' | 'url' | null {
  const a = rec(asset)
  const value = typeof a.value === 'string' ? a.value.trim() : ''
  if (!value) return null
  if (a.origin === 'upload' || a.source === 'upload' || value.startsWith('data:')) return 'upload'
  return isPlatformStorageUrl(value, hosts) ? 'upload' : 'url'
}

export interface GalleryCounts { uploads: number; urls: number }

export function countGallery(list: unknown, hosts: readonly string[] = platformStorageHosts()): GalleryCounts {
  const out = { uploads: 0, urls: 0 }
  for (const a of Array.isArray(list) ? list : []) {
    const o = galleryOrigin(a, hosts)
    if (o === 'upload') out.uploads++
    else if (o === 'url') out.urls++
  }
  return out
}

/** The gallery array inside an event's `eventDetails` (empty when absent). */
export function galleryOf(eventDetails: unknown): unknown[] {
  const g = rec(rec(eventDetails).media).galleryImages
  return Array.isArray(g) ? g : []
}

const uploadMsg = (n: number) =>
  `The gallery can hold up to ${GALLERY_UPLOAD_MAX} uploaded images (this event has ${n}). Remove ${n - GALLERY_UPLOAD_MAX} uploaded image${n - GALLERY_UPLOAD_MAX === 1 ? '' : 's'}, or add more photos by URL.`
const urlMsg = (n: number) =>
  `The gallery can hold up to ${GALLERY_URL_MAX} images added by URL (this event has ${n}). Remove ${n - GALLERY_URL_MAX}.`

/** STRICT — a new event (first publish) must be within both limits. Null when it is. */
export function galleryProblem(list: unknown, hosts?: readonly string[]): string | null {
  const c = countGallery(list, hosts)
  if (c.uploads > GALLERY_UPLOAD_MAX) return uploadMsg(c.uploads)
  if (c.urls > GALLERY_URL_MAX) return urlMsg(c.urls)
  return null
}

/**
 * GROWTH-ONLY — for any change to an existing gallery (draft save, live edit, resubmit copy): a
 * count may exceed its limit only if it already did and does not grow. Null when allowed.
 */
export function galleryChangeProblem(before: unknown, after: unknown, hosts?: readonly string[]): string | null {
  const b = countGallery(before, hosts), a = countGallery(after, hosts)
  if (a.uploads > Math.max(GALLERY_UPLOAD_MAX, b.uploads)) return uploadMsg(a.uploads)
  if (a.urls > Math.max(GALLERY_URL_MAX, b.urls)) return urlMsg(a.urls)
  return null
}
