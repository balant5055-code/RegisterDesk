// Certificate template metadata extraction — server-only.
// Detects file type from magic bytes and extracts dimensions / page count.
// Dependency-light: PDFs use pdf-lib (already a dependency); images are parsed
// directly from their headers so no image library is required.

import { PDFDocument } from 'pdf-lib'
import type { TemplateType, CertificateDimensions } from './types'

export interface TemplateInspection {
  type:       TemplateType | null     // detected from magic bytes (source of truth)
  dimensions: CertificateDimensions | null
  pageCount:  number | null           // PDFs only; null for images
}

/** Detects the template type from the file's magic bytes. */
export function detectTemplateType(b: Uint8Array): TemplateType | null {
  // %PDF
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf'
  // \x89 P N G
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  // FF D8 FF (JPEG SOI + marker)
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  return null
}

// PNG: IHDR is the first chunk; width/height are big-endian uint32 at bytes 16–23.
function pngDimensions(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 24) return null
  const width  = b[16] * 0x1000000 + b[17] * 0x10000 + b[18] * 0x100 + b[19]
  const height = b[20] * 0x1000000 + b[21] * 0x10000 + b[22] * 0x100 + b[23]
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

// JPEG: walk segment markers until a Start-Of-Frame (SOFn) marker, which carries
// the image height then width as big-endian uint16.
function jpgDimensions(b: Uint8Array): { width: number; height: number } | null {
  const len = b.length
  let o = 2 // skip the FF D8 SOI marker
  while (o + 9 < len) {
    if (b[o] !== 0xff) { o++; continue }
    let marker = b[o + 1]
    // Skip any fill bytes (sequences of 0xFF).
    while (marker === 0xff && o + 1 < len) { o++; marker = b[o + 1] }

    // Standalone markers with no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2
      continue
    }

    const segLen = b[o + 2] * 256 + b[o + 3]
    const isSOF =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSOF) {
      const height = b[o + 5] * 256 + b[o + 6]
      const width  = b[o + 7] * 256 + b[o + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }

    if (segLen < 2) return null // malformed
    o += 2 + segLen
  }
  return null
}

/**
 * Inspects raw template bytes: detects the type and extracts dimensions and (for
 * PDFs) the page count. Never throws — fields that can't be read come back null.
 */
export async function inspectTemplate(bytes: Uint8Array): Promise<TemplateInspection> {
  const type = detectTemplateType(bytes)

  if (type === 'pdf') {
    try {
      const doc   = await PDFDocument.load(bytes, { ignoreEncryption: true })
      const count = doc.getPageCount()
      const size  = count > 0 ? doc.getPage(0).getSize() : null
      return {
        type,
        pageCount: count,
        dimensions: size
          ? { width: Math.round(size.width), height: Math.round(size.height), unit: 'pt' }
          : null,
      }
    } catch {
      return { type, pageCount: null, dimensions: null }
    }
  }

  if (type === 'png') {
    const d = pngDimensions(bytes)
    return { type, pageCount: null, dimensions: d ? { ...d, unit: 'px' } : null }
  }

  if (type === 'jpg') {
    const d = jpgDimensions(bytes)
    return { type, pageCount: null, dimensions: d ? { ...d, unit: 'px' } : null }
  }

  return { type: null, pageCount: null, dimensions: null }
}
