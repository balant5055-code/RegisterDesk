// Centralized SSRF-safe URL validation + fetch for the certificate subsystem.
// Server-only. EVERY server-side fetch of an organizer-supplied URL (template
// files, builder assets, MVP logo/signature/background, generated certificate
// PDFs) must go through here.
//
// Defense model:
//   1. Allowlist host — the URL MUST be a Firebase Storage download URL
//      (firebasestorage.googleapis.com) for the CONFIGURED bucket. Because the
//      only reachable host is Google's public Storage endpoint, the server can
//      never be pointed at localhost / link-local / private hosts.
//   2. Explicit denylist (defense-in-depth) — localhost, loopback, link-local
//      (169.254/16, incl. cloud metadata), and RFC1918 private ranges are
//      rejected even if they somehow appear as the hostname.
//   3. Ownership — for event assets, the object path must live under the event's
//      own Storage prefix.
//   4. No redirect bypass — fetches use redirect:'manual'; any 3xx is rejected,
//      so an allowed URL cannot 302 to an internal target.

import { FIREBASE_STORAGE_BUCKET } from '@/lib/env'
import { templateStoragePrefix, CERT_GENERATED_STORAGE_ROOT, CERT_GLOBAL_STORAGE_ROOT, MAX_TEMPLATE_BYTES } from './constants'

const STORAGE_HOST = 'firebasestorage.googleapis.com'

export interface UrlCheck {
  ok:          boolean
  objectPath?: string
  reason?:     string
}

export class SsrfBlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`Blocked URL: ${reason}`)
    this.name = 'SsrfBlockedError'
  }
}

// Explicit denylist (belt-and-suspenders; the host allowlist already prevents
// these, but the spec requires them to be blocked outright).
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')   // strip IPv6 brackets

  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1')        return true           // IPv6 loopback
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true // IPv6 link-local / ULA

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const a = Number(m[1]), b = Number(m[2])
    if (a === 0)                          return true   // 0.0.0.0/8
    if (a === 127)                        return true   // 127.0.0.0/8 loopback
    if (a === 10)                         return true   // 10.0.0.0/8
    if (a === 169 && b === 254)           return true   // 169.254.0.0/16 link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31)  return true   // 172.16.0.0/12
    if (a === 192 && b === 168)           return true   // 192.168.0.0/16
  }
  return false
}

/**
 * Validates that a URL is a Firebase Storage download URL for the configured
 * bucket. This is the SSRF gate — the minimum required before any fetch.
 */
export function validateStorageUrl(rawUrl: string): UrlCheck {
  let u: URL
  try { u = new URL(rawUrl) } catch { return { ok: false, reason: 'invalid_url' } }

  if (u.protocol !== 'https:')           return { ok: false, reason: 'not_https' }
  if (isBlockedHostname(u.hostname))     return { ok: false, reason: 'blocked_host' }
  if (u.hostname !== STORAGE_HOST)       return { ok: false, reason: 'host_not_allowed' }

  // Path shape: /v0/b/{bucket}/o/{url-encoded-object}
  const m = u.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/)
  if (!m) return { ok: false, reason: 'not_a_storage_object' }

  const bucket = decodeURIComponent(m[1])
  if (FIREBASE_STORAGE_BUCKET && bucket !== FIREBASE_STORAGE_BUCKET) {
    return { ok: false, reason: 'bucket_mismatch' }
  }

  let objectPath: string
  try { objectPath = decodeURIComponent(m[2].split('?')[0]) } catch { return { ok: false, reason: 'bad_object_path' } }

  return { ok: true, objectPath }
}

/**
 * Validates a URL is a Storage object owned by this event — used for template
 * files and builder image assets (under certificates/templates/{uid}/{eventId}/).
 */
export function validateEventTemplateUrl(rawUrl: string, uid: string, eventId: string): UrlCheck {
  const base = validateStorageUrl(rawUrl)
  if (!base.ok) return base
  const prefix = `${templateStoragePrefix(uid, eventId)}/`
  if (!base.objectPath!.startsWith(prefix)) return { ok: false, reason: 'not_event_owned' }
  return base
}

/**
 * Validates an admin-curated GLOBAL template file URL (under certificates/global/).
 * Trusted, read-only, platform-owned — lets an imported global template render for
 * any organizer without copying its bytes (GA-6 S5).
 */
export function validateGlobalTemplateUrl(rawUrl: string): UrlCheck {
  const base = validateStorageUrl(rawUrl)
  if (!base.ok) return base
  if (!base.objectPath!.startsWith(`${CERT_GLOBAL_STORAGE_ROOT}/`)) return { ok: false, reason: 'not_global_template' }
  return base
}

/**
 * Validates a generated certificate file URL (server-written under
 * certificates/generated/{eventId}/), e.g. for the email attachment fetch.
 */
export function validateGeneratedCertificateUrl(rawUrl: string): UrlCheck {
  const base = validateStorageUrl(rawUrl)
  if (!base.ok) return base
  if (!base.objectPath!.startsWith(`${CERT_GENERATED_STORAGE_ROOT}/`)) return { ok: false, reason: 'not_generated_path' }
  return base
}

// ─── Safe fetch ─────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  timeoutMs?: number
  maxBytes?:  number
}

/**
 * Fetches bytes only after `check.ok`, with no redirect following (3xx → reject)
 * and a size cap. Throws SsrfBlockedError when the URL fails validation, or a
 * generic Error on fetch/size failure.
 */
export async function safeFetchBytes(
  url:   string,
  check: UrlCheck,
  opts:  SafeFetchOptions = {},
): Promise<Uint8Array> {
  if (!check.ok) throw new SsrfBlockedError(check.reason ?? 'invalid')

  const timeoutMs = opts.timeoutMs ?? 15000
  const maxBytes  = opts.maxBytes  ?? MAX_TEMPLATE_BYTES

  // redirect:'manual' — an allowed Storage URL must respond 200 directly; a 3xx
  // (a redirect to an internal target) is treated as a failure, never followed.
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
  if (!res.ok) throw new Error(`fetch_failed:${res.status}`)

  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new Error('file_too_large')

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error('file_too_large')
  return bytes
}
