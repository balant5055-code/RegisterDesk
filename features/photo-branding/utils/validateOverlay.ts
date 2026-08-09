// RD-PHOTO-01 · Overlay validation.
//
// The RULES are pure and testable; the ALPHA PROBE needs a decoder and lives beside them,
// clearly marked, because it is the one check that cannot be done on metadata alone.
//
// Everything runs BEFORE anything is uploaded. An organizer learns their artwork is a JPEG
// while looking at the requirements, not after a progress bar.

import {
  ASPECT_TOLERANCE, formatBytes, formatDimensions, recommendedAspect, specFor,
  type ArtworkSpec, type BrandingStyle,
} from '@/features/photo-branding/utils/artworkSpec'

export type OverlayRejection =
  | 'not-png' | 'too-large' | 'too-small' | 'too-big-dimensions'
  | 'wrong-aspect' | 'not-transparent' | 'unreadable'

export interface OverlayIssue {
  code:    OverlayRejection
  /** What the organizer is told. Names the actual number, never "invalid file". */
  message: string
}

export interface OverlayMetrics {
  width:    number
  height:   number
  bytes:    number
  mimeType: string
  /** True when at least one pixel is not fully opaque. */
  hasAlpha: boolean
}

export interface ValidationResult {
  ok:     boolean
  issues: OverlayIssue[]
}

/**
 * The pure half — everything decidable from metrics.
 *
 * Returns EVERY failure rather than the first. An organizer re-exporting artwork should
 * learn it is both a JPEG and too small in one pass, not across three attempts.
 */
export function validateOverlayMetrics(
  metrics: OverlayMetrics, style: BrandingStyle,
): ValidationResult {
  const spec = specFor(style)
  const issues: OverlayIssue[] = []

  if (metrics.mimeType !== 'image/png') {
    issues.push({
      code: 'not-png',
      message: `Branding artwork must be a PNG. This file is ${metrics.mimeType || 'an unknown type'}. `
        + 'A JPEG cannot hold a transparent background, so it would cover the photo with a solid block.',
    })
  }

  if (metrics.bytes > spec.maxBytes) {
    issues.push({
      code: 'too-large',
      message: `This file is ${formatBytes(metrics.bytes)}. The limit is ${formatBytes(spec.maxBytes)}.`,
    })
  }

  if (metrics.width < spec.minWidth || metrics.height < spec.minHeight) {
    issues.push({
      code: 'too-small',
      message: `This artwork is ${formatDimensions(metrics.width, metrics.height)}. `
        + `The minimum is ${formatDimensions(spec.minWidth, spec.minHeight)} — anything smaller looks soft once scaled onto a photo.`,
    })
  }

  if (metrics.width > spec.maxWidth || metrics.height > spec.maxHeight) {
    issues.push({
      code: 'too-big-dimensions',
      message: `This artwork is ${formatDimensions(metrics.width, metrics.height)}. `
        + `The maximum is ${formatDimensions(spec.maxWidth, spec.maxHeight)}.`,
    })
  }

  // Only meaningful once the dimensions themselves are sane.
  if (metrics.width > 0 && metrics.height > 0) {
    const aspect = metrics.width / metrics.height
    const target = recommendedAspect(spec)
    if (Math.abs(aspect - target) / target > ASPECT_TOLERANCE) {
      issues.push({
        code: 'wrong-aspect',
        message: `This artwork is ${aspect.toFixed(2)}:1. A bottom banner should be close to `
          + `${target.toFixed(2)}:1 (${formatDimensions(spec.recommendedWidth, spec.recommendedHeight)}). `
          + 'A very different shape will stretch or leave gaps.',
      })
    }
  }

  if (!metrics.hasAlpha) {
    issues.push({
      code: 'not-transparent',
      message: 'Every pixel in this PNG is opaque, so it would hide the bottom of every photo. '
        + 'Export with a transparent background (RGBA), not a white or coloured one.',
    })
  }

  return { ok: issues.length === 0, issues }
}

// ─── The impure half: reading the pixels ──────────────────────────────────────
//
// Transparency and colour mode cannot be read from a file's size or name — they need the
// image decoded. That happens in the BROWSER, using the same `createImageBitmap` + Canvas
// path Media Studio already uses for compression (RD-MEDIA-01). No new dependency, and no
// second image pipeline.

/** How many pixels the alpha probe samples. */
const ALPHA_SAMPLE_EDGE = 256

/**
 * Measures a file, including whether it actually carries transparency.
 *
 * The probe draws the image into a small canvas and looks for a non-opaque pixel. It samples
 * a downscaled copy rather than the full 2048×360: reading four megabytes of pixel data to
 * answer a yes/no question would stall the tab for no extra certainty, and downscaling
 * preserves alpha.
 *
 * DOM-only. Never called from a server module.
 */
export async function measureOverlay(file: File): Promise<OverlayMetrics> {
  const mimeType = (file.type || '').toLowerCase()
  const bytes = file.size

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // A file the browser cannot decode is reported as unreadable rather than as a
    // dimension failure — the organizer needs to know the file itself is the problem.
    return { width: 0, height: 0, bytes, mimeType, hasAlpha: false }
  }

  const { width, height } = bitmap

  try {
    const scale = Math.min(1, ALPHA_SAMPLE_EDGE / Math.max(width, height))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return { width, height, bytes, mimeType, hasAlpha: false }

    ctx.drawImage(bitmap, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data

    let hasAlpha = false
    // Stride of 4 — every pixel's alpha byte. Stops at the first transparent pixel found.
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) { hasAlpha = true; break }
    }

    return { width, height, bytes, mimeType, hasAlpha }
  } finally {
    // ImageBitmaps hold native memory that GC does not reclaim promptly.
    bitmap.close()
  }
}

/** Measure and validate in one call — what the upload control uses. */
export async function validateOverlayFile(
  file: File, style: BrandingStyle,
): Promise<ValidationResult & { metrics: OverlayMetrics }> {
  const metrics = await measureOverlay(file)

  if (metrics.width === 0 || metrics.height === 0) {
    return {
      ok: false,
      metrics,
      issues: [{
        code: 'unreadable',
        message: 'This file could not be read as an image. Export it again as a PNG.',
      }],
    }
  }

  return { ...validateOverlayMetrics(metrics, style), metrics }
}

export type { ArtworkSpec }
