// RD-SUPPORT-01 — screenshot checks. PURE (no Firebase): the server runs this on every upload.
//
// A file's declared type and name are attacker-controlled, so the stored type comes from the bytes
// (sniffImageMime — the same magic-byte check attendee photos use). PNG, JPEG and WebP only: SVG is
// an executable document and is refused like anything else that is not one of the three.

import { sniffImageMime } from '@/lib/registrations/attendeePhotoMime'
import { LIMITS, ATTACHMENT_TYPES, displayFilename, type AttachmentType } from './types'

export interface IncomingFile { name: string; declaredType: string; bytes: Uint8Array }
export interface CheckedFile { name: string; contentType: AttachmentType; bytes: Uint8Array; size: number }

export type FileCheck = { ok: true; files: CheckedFile[] } | { ok: false; error: string }

export function checkFiles(files: IncomingFile[], alreadyOnTicket = 0): FileCheck {
  if (files.length === 0) return { ok: true, files: [] }
  if (files.length > LIMITS.filesPerMessage) return { ok: false, error: `Attach up to ${LIMITS.filesPerMessage} screenshots per message.` }
  if (alreadyOnTicket + files.length > LIMITS.filesPerTicket) return { ok: false, error: `A ticket can hold up to ${LIMITS.filesPerTicket} screenshots.` }
  const total = files.reduce((n, f) => n + f.bytes.byteLength, 0)
  if (total > LIMITS.totalUploadBytes) return { ok: false, error: `Screenshots must be ${Math.round(LIMITS.totalUploadBytes / 1024 / 1024)} MB or less in total.` }
  const out: CheckedFile[] = []
  for (const f of files) {
    if (f.bytes.byteLength === 0) return { ok: false, error: 'One of the files is empty.' }
    const sniffed = sniffImageMime(f.bytes)
    if (!sniffed || !(ATTACHMENT_TYPES as readonly string[]).includes(sniffed)) {
      return { ok: false, error: 'Only PNG, JPEG or WebP screenshots can be attached.' }
    }
    // A declared type that disagrees with the bytes is refused rather than corrected.
    const declared = f.declaredType.toLowerCase().replace('image/jpg', 'image/jpeg')
    if (declared && declared !== 'application/octet-stream' && declared !== sniffed) {
      return { ok: false, error: 'A file’s type does not match its contents.' }
    }
    out.push({ name: displayFilename(f.name, sniffed), contentType: sniffed, bytes: f.bytes, size: f.bytes.byteLength })
  }
  return { ok: true, files: out }
}

/** Headers for serving a stored screenshot to an authorized viewer. Never cached, never sniffed,
 *  never able to run script even if a file were mislabelled. */
export function attachmentHeaders(contentType: AttachmentType, name: string, size: number): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Content-Length': String(size),
    'Content-Disposition': `inline; filename="${name.replace(/["\\\r\n]/g, '_')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  }
}
