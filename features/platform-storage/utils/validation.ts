// RD-STORAGE-01 · Platform Storage — upload validation.
//
// PURE. No SDK, no I/O.
//
// Enforced BEFORE any byte reaches a provider: content type, size, extension, and the
// certificate-visibility rule. A provider never sees an unvalidated upload.

import { StorageError } from '@/features/platform-storage/types/errors'
import type { StorageAssetType, StorageVisibility } from '@/features/platform-storage/types'
import { extensionForMime } from './objectKey'

// ─── Allowed types + size ceilings, per asset type ────────────────────────────

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const

interface TypePolicy {
  mimeTypes: readonly string[]
  maxBytes:  number
}

const MB = 1024 * 1024

/**
 * One policy per asset type. Deliberately narrow — an allow-list, never a deny-list, so a
 * novel dangerous type (svg with script, html, wasm) is refused by default rather than
 * needing to be anticipated.
 *
 * `image/svg+xml` is NOT allowed anywhere: an SVG is an executable document, and one served
 * from a public bucket on our own origin is a stored-XSS vector.
 */
const POLICY: Readonly<Record<StorageAssetType, TypePolicy>> = {
  'event-banner':          { mimeTypes: IMAGE_TYPES, maxBytes: 10 * MB },
  'event-photo-original':  { mimeTypes: IMAGE_TYPES, maxBytes: 50 * MB },
  'event-photo-medium':    { mimeTypes: IMAGE_TYPES, maxBytes: 10 * MB },
  'event-photo-thumbnail': { mimeTypes: IMAGE_TYPES, maxBytes:  2 * MB },
  'event-certificate':     { mimeTypes: ['application/pdf', 'image/png'], maxBytes: 25 * MB },
  // RD-CERT-TPL-R2 — the organizer's uploaded template. The ceiling matches the largest
  // TEMPLATE_SIZE_LIMITS entry (pdf 25 MB); the per-type limits (pdf 25 / png,jpg 10) stay
  // enforced by lib/certificates so the storage layer never becomes a second source of
  // truth for a product rule.
  'event-certificate-template': {
    mimeTypes: ['application/pdf', 'image/png', 'image/jpeg'], maxBytes: 25 * MB,
  },
  'event-finisher-badge':  { mimeTypes: ['image/png', 'image/jpeg', 'image/webp'], maxBytes: 10 * MB },
  // RD-PHOTO-01 — PNG ONLY, and deliberately so: the overlay must carry an alpha channel,
  // and JPEG cannot. The narrow policy is what makes "transparent PNG" enforceable at the
  // storage boundary rather than only in the UI.
  'event-branding-overlay': { mimeTypes: ['image/png'], maxBytes: 2 * MB },
  'event-report':          {
    mimeTypes: [
      'text/csv',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/zip',
      // RD-CERT-ARTIFACT-01 — machine-readable manifests for a sharded archive.
      'application/json',
    ],
    maxBytes: 100 * MB,
  },
  'marketing-logo':        { mimeTypes: IMAGE_TYPES, maxBytes:  5 * MB },
  'marketing-sponsor':     { mimeTypes: IMAGE_TYPES, maxBytes:  5 * MB },
  'system':                { mimeTypes: ['application/json', 'text/csv', 'application/zip'], maxBytes: 25 * MB },
}

export function policyFor(type: StorageAssetType): TypePolicy {
  const policy = POLICY[type]
  if (!policy) throw new StorageError('INVALID_INPUT', `Unknown asset type: ${type}`)
  return policy
}

export function allowedMimeTypes(type: StorageAssetType): readonly string[] {
  return policyFor(type).mimeTypes
}

export function maxBytesFor(type: StorageAssetType): number {
  return policyFor(type).maxBytes
}

// ─── Checks ───────────────────────────────────────────────────────────────────

/** Normalises `image/JPEG; charset=x` → `image/jpeg`. */
export function normalizeMimeType(raw: string): string {
  return raw.split(';')[0].trim().toLowerCase()
}

export function assertMimeAllowed(type: StorageAssetType, mimeType: string): string {
  const normalized = normalizeMimeType(mimeType)
  if (!policyFor(type).mimeTypes.includes(normalized)) {
    throw new StorageError(
      'UNSUPPORTED_TYPE',
      `${normalized || 'an unknown type'} is not allowed for ${type}. `
      + `Allowed: ${policyFor(type).mimeTypes.join(', ')}.`,
    )
  }
  // A type with no canonical extension cannot produce a well-formed key.
  if (!extensionForMime(normalized)) {
    throw new StorageError('UNSUPPORTED_TYPE', `No canonical file extension for ${normalized}.`)
  }
  return normalized
}

export function assertSizeAllowed(type: StorageAssetType, size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw new StorageError('INVALID_INPUT', 'Upload is empty.')
  }
  const max = maxBytesFor(type)
  if (size > max) {
    throw new StorageError(
      'FILE_TOO_LARGE',
      `File is ${(size / MB).toFixed(1)} MB; the maximum for ${type} is ${Math.round(max / MB)} MB.`,
    )
  }
}

/**
 * Rejects an extension that contradicts the declared mime type.
 *
 * The extension is only ever taken from the mime type when building a key, so this is a
 * consistency check on the ORIGINAL filename — it catches a `.exe` renamed to look like a
 * PNG before the bytes are stored, and it is why the check is by mismatch rather than by
 * an extension deny-list.
 */
export function assertExtensionConsistent(
  originalFilename: string | null | undefined,
  mimeType: string,
): void {
  if (!originalFilename) return
  const dot = originalFilename.lastIndexOf('.')
  if (dot === -1) return

  const claimed  = originalFilename.slice(dot + 1).toLowerCase()
  const expected = extensionForMime(normalizeMimeType(mimeType))
  if (!expected) return

  // jpg/jpeg are the same thing; everything else must match exactly.
  const equivalent =
    claimed === expected ||
    (expected === 'jpg' && claimed === 'jpeg')

  if (!equivalent) {
    throw new StorageError(
      'UNSUPPORTED_TYPE',
      `File extension ".${claimed}" does not match its content type (${normalizeMimeType(mimeType)}).`,
    )
  }
}

/**
 * THE certificate rule.
 *
 * A certificate names a participant and carries their result. The existing certificate
 * module treats its identifiers as capability tokens; making one PUBLIC in the bucket would
 * quietly undo that. This is the single place the rule is enforced, and it throws rather
 * than silently downgrading — a caller asking for a public certificate has a bug worth
 * seeing.
 */
export function assertVisibilityAllowed(
  type: StorageAssetType,
  visibility: StorageVisibility,
): void {
  if (type === 'event-certificate' && visibility === 'PUBLIC') {
    throw new StorageError(
      'FORBIDDEN',
      'Certificates cannot be stored with PUBLIC visibility. Use PRIVATE or SIGNED_URL.',
    )
  }
  // A template is the organizer's design asset — enumerable artwork would leak their work
  // and, for a PDF template, whatever is embedded in it.
  if (type === 'event-certificate-template' && visibility === 'PUBLIC') {
    throw new StorageError(
      'FORBIDDEN',
      'Certificate templates cannot be stored with PUBLIC visibility. Use PRIVATE or SIGNED_URL.',
    )
  }
  if (type === 'event-report' && visibility === 'PUBLIC') {
    throw new StorageError(
      'FORBIDDEN',
      'Reports cannot be stored with PUBLIC visibility. Use PRIVATE or SIGNED_URL.',
    )
  }
}
