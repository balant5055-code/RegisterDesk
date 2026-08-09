// RD-STORAGE-01 · Platform Storage — content hashing.
//
// SHA-256 over the bytes, hex. Two uses:
//   • integrity — prove the object in the bucket is the object we uploaded
//   • duplicate detection — the same bytes always produce the same checksum
//
// Node's `crypto` is used directly (already a dependency of this codebase's server code).
// Server-only, because uploads are server-only by design.

import { createHash } from 'crypto'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** True when two checksums refer to identical content. */
export function isSameContent(a: string, b: string): boolean {
  return a.length > 0 && a === b
}
