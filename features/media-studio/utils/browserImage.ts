'use client'

// RD-MEDIA-01 · Browser-side image processing.
//
// ─── Why compression happens in the BROWSER ──────────────────────────────────
// The audit found no server-side image library, and adding one (`sharp`) would mean routing
// every byte through the app server — which contradicts direct-to-storage upload and, on a
// serverless deployment, hits a 4.5 MB body limit immediately.
//
// So the browser does it, using Canvas: decode → resize → re-encode. That is what every
// serious bulk-photo product does, and it means:
//   • the organizer never compresses anything by hand
//   • compression cost is the organizer's CPU, parallel and free
//   • only already-compressed bytes cross the network
//
// The trade, stated plainly: the server cannot verify a derivative was produced faithfully.
// It DOES verify each object exists and takes its size from the bucket, so counters and
// billing are honest — but the pixels are the client's word. Acceptable, because the actor
// is the organizer uploading their own event's photos.
//
// DOM-only. Never imported by a server module.

import type { CompressionProfile } from './compressionProfiles'
import type { MediaRendition } from '@/features/media-studio/types'
import { placeOverlay } from '@/features/photo-branding/utils/placement'
import type { BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'

/** Longest edge for each derivative. */
export const MEDIUM_MAX_EDGE    = 1600
export const THUMBNAIL_MAX_EDGE = 400

/**
 * RD-PHOTO-03 · An overlay, already decoded, ready to be drawn.
 *
 * ─── The decode happens ONCE PER BATCH, not once per photo ───────────────────
 * This is a decoded bitmap rather than a Blob or a URL precisely so that importing 4,000
 * photos decodes the artwork ONCE. Passing bytes here would decode it 4,000 times for no
 * benefit; the caller (`useUploadQueue`) prepares it before the run and closes it after.
 *
 * `drawImage` only reads, so one bitmap is safe across concurrent photos.
 */
export interface PreparedOverlay {
  image:  ImageBitmap | HTMLImageElement
  width:  number
  height: number
  style:  BrandingStyle
}

export interface ProcessedImage {
  rendition: MediaRendition
  blob:      Blob
  width:     number
  height:    number
  mimeType:  string
}

export interface SourceInfo {
  width:  number
  height: number
}

/** sha256 hex of a file's bytes, via Web Crypto. This is the duplicate-detection key, and it
 *  is computed on the ORIGINAL — hashing a re-encode would make a photo stop matching itself.
 *
 *  RD-MEDIA-PERF-03: takes BYTES, not a Blob. It used to call `file.arrayBuffer()` itself,
 *  and `decode()` then read the same file a second time — two full disk reads and two
 *  multi-megabyte heap copies per photo. The caller now reads once and passes the buffer to
 *  both. */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('This browser cannot compute checksums (Web Crypto unavailable).')
  const digest = await subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Decodes an image. `createImageBitmap` is used where available because it decodes OFF the
 * main thread — with thousands of photos, decoding on the UI thread freezes the tab.
 *
 * ═══ RD-MS-CLOSURE-01 · EXIF ORIENTATION ════════════════════════════════════
 * `imageOrientation: 'from-image'` is NOT optional. Every rendition is redrawn through a
 * canvas, and a canvas re-encode discards EXIF — including the orientation tag. A phone
 * photographs in landscape and records "rotate 90°" in EXIF; if that tag is dropped before
 * the draw, the stored JPEG is sideways FOREVER. There is no rotate tool to recover with, and
 * the unrotated source no longer exists once the upload completes.
 *
 * Without this option the behaviour is browser-dependent — some engines apply orientation to
 * the decoded bitmap and some do not — so the same photo uploaded from Safari and from
 * Firefox could land in two different rotations. Passing it explicitly makes the result the
 * same everywhere and matches what the user saw in their camera roll.
 *
 * The `<img>` fallback below needs no equivalent: browsers already apply EXIF orientation
 * when rendering an `<img>`, which is the behaviour this option asks `createImageBitmap` for.
 */
async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // An engine that rejects the options bag rather than ignoring it. Decoding without
      // orientation beats failing the upload — the `<img>` path below applies it anyway.
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be read as an image.')) }
    img.src = url
  })
}

function dimensionsOf(source: ImageBitmap | HTMLImageElement): SourceInfo {
  return {
    width:  'width'  in source ? source.width  : 0,
    height: 'height' in source ? source.height : 0,
  }
}

/** Scales to fit `maxEdge`, never enlarging — upscaling a photo adds bytes and no detail. */
function fit(width: number, height: number, maxEdge: number | null): { w: number; h: number } {
  if (maxEdge === null) return { w: width, h: height }
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { w: width, h: height }
  const scale = maxEdge / longest
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) }
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('The browser could not encode this image.')),
      mimeType,
      quality / 100,
    )
  })
}

/**
 * ONE canvas, ONE encode — with the overlay drawn inside the SAME pass.
 *
 * ─── This is the whole point of RD-PHOTO-03 ──────────────────────────────────
 * Branding used to be a second, later pipeline: decode the stored photo, composite, encode
 * again. Here the overlay is simply a second `drawImage` onto the canvas that the resize is
 * already using. Adding branding costs one raster blit and:
 *
 *   • zero extra decodes   — the photo is decoded once, in `processImage`
 *   • zero extra encodes   — `toBlob` still runs exactly once per rendition
 *   • zero extra fetches   — the artwork bitmap is passed in, prepared once per batch
 *   • zero extra objects   — the branded pixels ARE the rendition
 *
 * Placement is delegated to `placeOverlay` (pure, shared with the branding page's preview),
 * so what an organizer previews and what is baked in are computed by the same function.
 */
async function render(
  source: ImageBitmap | HTMLImageElement,
  w: number, h: number, mimeType: string, quality: number,
  overlay?: PreparedOverlay | null,
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('The browser could not create a drawing surface.')

  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h)

  if (overlay) {
    // Placement is computed against the OUTPUT size, so every rendition gets a banner in
    // the same proportion — the thumbnail is a smaller version of the same picture, not a
    // differently-branded one.
    const box = placeOverlay({
      photoWidth: w, photoHeight: h,
      overlayWidth: overlay.width, overlayHeight: overlay.height,
      style: overlay.style,
    })
    ctx.drawImage(overlay.image as CanvasImageSource, box.x, box.y, box.width, box.height)
  }

  return canvasToBlob(canvas, mimeType, quality)
}

/**
 * Reports progress through the CPU stages, so the UI can name what is happening.
 *
 * Called on entry to each stage. The queue turns it into the per-photo checklist; without it
 * an item read "processing" from the moment work began until it finished, which covered the
 * decode, three encodes, the prepare call, three PUTs and the complete call — roughly 80% of
 * its life under one wrong label.
 */
export type StageReporter = (stage: 'read' | 'checksum' | 'decode' | 'encode') => void

export interface ProcessPlan {
  keepOriginal:      boolean
  generateMedium:    boolean
  generateThumbnail: boolean
}

export interface ProcessResult {
  renditions: ProcessedImage[]
  source:     SourceInfo
  checksum:   string
}

/**
 * Produces every rendition for one photo.
 *
 * `original` under a non-`original` profile means "the full-size image, compressed to the
 * profile" — not the untouched file. Only the `original` profile (targetBytes === null)
 * passes the source bytes through verbatim, AND ONLY WHEN THERE IS NO OVERLAY: bytes that
 * never touch a canvas cannot carry branding. See the branch below.
 *
 * Output is JPEG throughout: it is universally decodable, and mixing formats per rendition
 * would complicate every downstream URL for no gain at this stage.
 *
 * RD-PHOTO-03: `overlay` is drawn into every rendition during this single decode. The photo
 * is decoded once here and each rendition is encoded once, branded or not — the cost of
 * branding is one extra blit per canvas that already existed.
 */
export async function processImage(
  file: File,
  profile: CompressionProfile,
  plan: ProcessPlan,
  overlay?: PreparedOverlay | null,
  onStage?: StageReporter,
  /**
   * MS-FINAL-01 · A digest already computed for this exact file.
   *
   * The pre-flight duplicate scan reads and hashes every queued photo before the upload
   * starts. Hashing again here would repeat that work on every file in the batch — minutes
   * of CPU over a large folder, for an answer already known. Omitted, behaviour is
   * exactly as before.
   */
  knownChecksum?: string | null,
): Promise<ProcessResult> {
  // ONE read. The bytes feed both the checksum and the decode — see `hashBytes`.
  onStage?.('read')
  const bytes = await file.arrayBuffer()

  onStage?.('checksum')
  const checksum = knownChecksum ?? await hashBytes(bytes)

  onStage?.('decode')
  // A Blob view over the buffer we already hold: no second disk read, and `createImageBitmap`
  // takes the same path it did before.
  const source = await decode(new Blob([bytes], { type: file.type || 'image/jpeg' }))
  const dims   = dimensionsOf(source)

  if (dims.width === 0 || dims.height === 0) {
    throw new Error('This image has no readable dimensions.')
  }

  const renditions: ProcessedImage[] = []
  const outputMime = 'image/jpeg'

  onStage?.('encode')
  try {
    if (plan.keepOriginal) {
      // The passthrough is only correct for UNBRANDED imports. With an overlay the file has
      // to go through a canvas — otherwise the "Original" profile would silently store the
      // one unbranded copy in the whole event, which is exactly the mixed gallery the
      // branding lock exists to prevent.
      if (profile.targetBytes === null && !overlay) {
        renditions.push({
          rendition: 'original', blob: file,
          width: dims.width, height: dims.height,
          mimeType: file.type || outputMime,
        })
      } else {
        const { w, h } = fit(dims.width, dims.height, profile.maxWidth)
        renditions.push({
          rendition: 'original',
          blob: await render(source, w, h, outputMime, profile.jpegQuality, overlay),
          width: w, height: h, mimeType: outputMime,
        })
      }
    }

    if (plan.generateMedium) {
      const { w, h } = fit(dims.width, dims.height, MEDIUM_MAX_EDGE)
      renditions.push({
        rendition: 'medium',
        blob: await render(source, w, h, outputMime, Math.min(profile.jpegQuality, 82), overlay),
        width: w, height: h, mimeType: outputMime,
      })
    }

    if (plan.generateThumbnail) {
      const { w, h } = fit(dims.width, dims.height, THUMBNAIL_MAX_EDGE)
      renditions.push({
        rendition: 'thumbnail',
        blob: await render(source, w, h, outputMime, 72, overlay),
        width: w, height: h, mimeType: outputMime,
      })
    }
  } finally {
    // ImageBitmaps hold GPU/native memory that GC will not reclaim promptly. With thousands
    // of photos, not closing them exhausts the tab.
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close()
  }

  return { renditions, source: dims, checksum }
}

/** PUTs a blob to a presigned URL. The only place the browser touches object storage. */
/**
 * How long one rendition's PUT may take before it is treated as a timeout.
 *
 * RD-MEDIA-03: without this, a stalled connection to object storage hangs the whole queue
 * with no error and no progress — the failure an organizer reported as "it just stops".
 * Two minutes is generous for a single compressed rendition on a slow uplink.
 */
export const UPLOAD_TIMEOUT_MS = 120_000

export async function putToSignedUrl(
  uploadUrl: string, blob: Blob, mimeType: string, signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS)
  // Honour a caller's cancellation as well as the timeout.
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)

  try {
    const res = await fetch(uploadUrl, {
      method:  'PUT',
      body:    blob,
      headers: { 'Content-Type': mimeType },
      signal:  controller.signal,
    })
    if (!res.ok) {
      // The provider's body is not shown to the organizer — it is vendor detail. The status
      // IS kept: `classifyUploadError` reads it to tell a rate limit from a rejected file.
      throw new Error(`Upload failed (${res.status}). Please retry.`)
    }
  } catch (e) {
    // An abort surfaces as a DOMException with no useful message; name it so the classifier
    // can tell a timeout from a dropped connection.
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(signal?.aborted ? 'Upload aborted.' : 'Upload timed out.')
    }
    throw e
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
