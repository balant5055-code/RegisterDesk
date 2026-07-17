// Safe image-URL validation for next/Image.
//
// next/Image throws "Invalid src prop … hostname is not configured under images"
// at runtime for any remote host not listed in next.config.ts `remotePatterns`.
// Organiser-supplied cover URLs (a free-text paste field) can therefore contain
// hostnames — most commonly Google image thumbnails (encrypted-tbn0.gstatic.com)
// — that crash the page.
//
// This module is the single guard: only URLs on APPROVED_IMAGE_HOSTS (kept in
// sync with next.config remotePatterns) or same-origin relative paths are
// considered renderable. Everything else — Google cached thumbnails,
// googleusercontent mirrors, empty/undefined values, and malformed strings —
// resolves to `false`/fallback and NEVER throws.
//
// Pure + isomorphic: no Firebase/DOM imports, safe on server and client.

// Approved image hosts. MUST stay in sync with `remotePatterns` in
// next.config.ts so any URL that passes isValidImageUrl() is guaranteed to
// render through next/Image without throwing.
export const APPROVED_IMAGE_HOSTS: readonly string[] = [
  'firebasestorage.googleapis.com', // Firebase Storage download URLs
  'storage.googleapis.com',         // GCS / Firebase alternate host
  'res.cloudinary.com',             // Cloudinary
  'images.unsplash.com',            // Unsplash (curated demo imagery)
]

const APPROVED = new Set(APPROVED_IMAGE_HOSTS)

/**
 * True only for a string URL that next/Image can safely render:
 *   • a same-origin relative path ("/images/…"), or
 *   • an http(s) URL whose host is on the approved allow-list.
 *
 * Explicitly rejects Google cached thumbnails / user-content mirrors, empty
 * strings, undefined/null, and malformed URLs. Never throws.
 */
export function isValidImageUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (!trimmed) return false

  // Same-origin relative asset (e.g. "/images/placeholders/cause-cover.webp").
  // Protocol-relative ("//host/…") is treated as remote and validated below.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false // malformed → never throw, treat as invalid
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false

  const host = parsed.hostname.toLowerCase()

  // Dev convenience: allow locally-served images (Firebase emulator, etc.).
  if (process.env.NODE_ENV === 'development' && (host === 'localhost' || host === '127.0.0.1')) {
    return true
  }

  // Never accept Google cached thumbnails or user-content mirrors — they are
  // hotlink-protected, ephemeral, and must not be stored or rendered.
  if (host.endsWith('gstatic.com') || host.endsWith('googleusercontent.com')) return false

  return APPROVED.has(host)
}

/**
 * Returns `url` when it is a safe, renderable image source, otherwise the
 * `fallback` (default `null` so callers can render their existing empty state).
 * Never throws.
 */
export function safeImageUrl(url: unknown, fallback: string | null = null): string | null {
  return isValidImageUrl(url) ? url : fallback
}
