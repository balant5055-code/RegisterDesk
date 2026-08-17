// RD-CERT-TPL-SIZE — certificate template raster optimisation, at the UPLOAD boundary.
//
// ═══ THE PROBLEM ════════════════════════════════════════════════════════════
// pdf-lib embeds the two raster formats in completely different ways:
//
//   embedJpg → context.stream(imageData, { Filter: 'DCTDecode' })   the ORIGINAL bytes, verbatim
//   embedPng → context.flateStream(image.rgbChannel, …)             DECODED to raw pixels, re-Flated
//
// So a PNG never reaches the PDF as a PNG. A 3508×2480 background becomes a 24.89 MB raw RGB
// stream (plus an 8.3 MB alpha SMask when transparent), which Flate compresses ~3:1 — an
// 8.35 MB certificate. The same artwork as JPEG passes straight through at a few hundred KB.
//
// ═══ WHY AT UPLOAD, AND WHY IN THE BROWSER ══════════════════════════════════
// Converting per render would re-encode the same background for every certificate in a
// 10,000-strong job. Converting once, when the organizer uploads, costs nothing afterwards.
//
// It happens in the browser because the browser is ALREADY the only place holding the bytes:
// templates are uploaded direct-to-R2 through a signed PUT, so a server-side encoder would
// mean routing 25 MB through a serverless function AND adding an image dependency this
// repository does not have (no sharp / jimp / canvas in package.json). Canvas encoding is the
// established pattern here — see media-studio's browserImage and photo-branding's
// measureOverlay, whose alpha probe this mirrors.
//
// ═══ WHAT IS DELIBERATELY NOT DONE ══════════════════════════════════════════
// Resolution is never reduced — 3508×2480 is A4 at 300 DPI and downscaling would visibly
// soften print output. Text is never rasterised; it stays vector PDF text drawn at render
// time. A PNG carrying real transparency is left ALONE, because flattening it would silently
// destroy artwork the organizer designed to composite.

/** Quality for the flattened background. High enough that a certificate is visually
 *  indistinguishable, low enough to collapse a multi-megabyte lossless raster. */
export const TEMPLATE_JPEG_QUALITY = 0.85

/** Alpha probe resolution — matches photo-branding's overlay check. Sampling a scaled copy
 *  is enough to answer "is any pixel transparent" without reading 8.7M pixels. */
const ALPHA_SAMPLE_EDGE = 512

export type RasterTemplateType = 'png' | 'jpg'

/**
 * Should this upload be flattened to JPEG?
 *
 * PURE — no DOM, no canvas — so the policy is unit-testable without a browser.
 *
 *   pdf            → never (not a raster; pdf-lib copies the page)
 *   jpg            → never (already takes the passthrough branch)
 *   png, no alpha  → YES   (this is the 8.35 MB case)
 *   png, has alpha → NO    (transparency is load-bearing; keep it lossless)
 */
export function shouldFlattenToJpeg(
  templateType: 'pdf' | 'png' | 'jpg',
  hasAlpha: boolean,
): boolean {
  if (templateType !== 'png') return false
  return !hasAlpha
}

/** `certificate.png` → `certificate.jpg`. Keeps the stem so the organizer still recognises
 *  the file in the templates list; the extension must match the bytes actually stored. */
export function jpegNameFor(fileName: string): string {
  return `${fileName.replace(/\.[^.]+$/, '')}.jpg`
}

// ─── Browser-only below this line ─────────────────────────────────────────────

/**
 * True when ANY pixel is not fully opaque.
 *
 * Reads a scaled copy: the question is existential, so a 512px probe answers it at a fraction
 * of the cost. Any failure to decode reports `true` — the SAFE direction, because it leaves
 * the upload on the lossless PNG path rather than flattening artwork we could not inspect.
 */
export async function rasterHasAlpha(file: File): Promise<boolean> {
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return true                       // undecodable → do not touch it
  }
  try {
    const { width, height } = bitmap
    const scale = Math.min(1, ALPHA_SAMPLE_EDGE / Math.max(width, height))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w; canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return true

    ctx.drawImage(bitmap, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    // Stride of 4 — every pixel's alpha byte. Stops at the first transparent pixel.
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true
    }
    return false
  } catch {
    return true
  } finally {
    bitmap?.close()                   // ImageBitmaps hold native memory GC does not reclaim promptly
  }
}

/**
 * Re-encodes an opaque raster as JPEG at its ORIGINAL pixel dimensions.
 *
 * Returns the original file unchanged on any failure — a larger certificate is strictly
 * better than a failed upload, and the render path handles PNG correctly either way.
 */
export async function encodeTemplateAsJpeg(file: File): Promise<File | null> {
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    const { width, height } = bitmap

    const canvas = document.createElement('canvas')
    canvas.width = width; canvas.height = height        // NO downscale — print resolution is preserved
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    // JPEG has no alpha. This path only runs on rasters already proven opaque, but the white
    // ground makes the result deterministic if that ever changes.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0)

    const blob = await new Promise<Blob | null>(resolve => {
      canvas.toBlob(resolve, 'image/jpeg', TEMPLATE_JPEG_QUALITY)
    })
    if (!blob) return null
    return new File([blob], jpegNameFor(file.name), { type: 'image/jpeg' })
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}

/**
 * The upload-boundary entry point: decides, converts, and reports what to store.
 *
 * Always returns something usable. When nothing is done — PDF, JPEG, transparent PNG, or a
 * conversion that failed — the caller uploads exactly what the organizer chose.
 */
export async function optimizeTemplateUpload(
  file: File,
  templateType: 'pdf' | 'png' | 'jpg',
): Promise<{ file: File; templateType: 'pdf' | 'png' | 'jpg'; converted: boolean }> {
  if (templateType !== 'png') return { file, templateType, converted: false }

  if (!shouldFlattenToJpeg(templateType, await rasterHasAlpha(file))) {
    return { file, templateType, converted: false }
  }

  const jpeg = await encodeTemplateAsJpeg(file)
  if (!jpeg) return { file, templateType, converted: false }

  // The stored TYPE must match the stored BYTES: render.ts branches on templateType to pick
  // embedJpg, and the prepare route signs the PUT with the matching content type.
  return { file: jpeg, templateType: 'jpg', converted: true }
}
