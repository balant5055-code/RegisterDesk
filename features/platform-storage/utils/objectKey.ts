// RD-STORAGE-01 · Platform Storage — object identity.
//
// PURE apart from `crypto.randomUUID`, which is available in both Node and the browser.
//
// ─── The rule: NEVER store an uploader's filename ────────────────────────────
// A stored key is always a generated id plus a canonical extension derived from the
// VALIDATED mime type. The uploader's filename is retained only as metadata.
//
// Four reasons, all of which have bitten real systems:
//   1. Path traversal — `../../secrets.pdf`.
//   2. Collisions — two people upload `results.xlsx`; one silently overwrites the other.
//   3. Information disclosure — a public URL that reads
//      `.../Q3-layoffs-FINAL-confidential.pdf` leaks before it is even opened.
//   4. Portability — unicode normalisation, case-sensitivity and length limits differ
//      between S3, R2, Azure and a local filesystem. A generated id behaves identically
//      everywhere.

import { StorageError } from '@/features/platform-storage/types/errors'

/** Canonical extension per allowed mime type. Derived from the TYPE, never from the name. */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg':      'jpg',
  'image/png':       'png',
  'image/webp':      'webp',
  'image/avif':      'avif',
  'image/gif':       'gif',
  'application/pdf': 'pdf',
  'text/csv':        'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/zip': 'zip',
  'application/json': 'json',
}

export function extensionForMime(mimeType: string): string | null {
  return EXTENSION_BY_MIME[mimeType.toLowerCase()] ?? null
}

/**
 * A new object id: `{uuid}.{ext}`.
 *
 * The extension comes from the mime type the validator already accepted, so it always
 * matches the bytes' declared type. When the type has no canonical extension the id is
 * extension-less rather than guessed.
 */
export function generateObjectId(mimeType: string): string {
  const uuid = crypto.randomUUID()
  const ext  = extensionForMime(mimeType)
  return ext ? `${uuid}.${ext}` : uuid
}

/**
 * Sanitises an uploader's filename for STORAGE AS METADATA.
 *
 * Never used to build a key. Bounded, control-characters stripped, path separators removed,
 * so a hostile filename cannot break a log line, a CSV export or a Content-Disposition
 * header downstream.
 */
export function sanitizeOriginalFilename(name: string | null | undefined): string | null {
  if (!name) return null
  const cleaned = [...name.trim()]
    .filter(ch => {
      const c = ch.codePointAt(0) ?? 0
      return c >= 0x20 && c !== 0x7f
    })
    .join('')
    .replace(/[/\\]/g, '_')
    .slice(0, 200)
  return cleaned === '' ? null : cleaned
}

/** The id portion of a key — the last segment. */
export function objectIdFromKey(key: string): string {
  const i = key.lastIndexOf('/')
  return i === -1 ? key : key.slice(i + 1)
}

/** Asserts a caller-supplied id is a plain, single-segment token. */
export function assertSafeObjectId(objectId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(objectId)) {
    throw new StorageError(
      'INVALID_INPUT',
      `Invalid object id: ${JSON.stringify(objectId.slice(0, 80))}`,
    )
  }
}
