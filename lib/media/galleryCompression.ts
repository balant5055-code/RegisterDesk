// lib/media/galleryCompression.ts
// RD-GALLERY-01 — the compression DECISIONS for an uploaded gallery image, separated from the canvas
// so they are testable without a browser. PURE: the caller supplies the encoder.
//
//   1. never upscale; shrink so the longest side is ≤ maxDimension (aspect ratio kept)
//   2. step quality down from 0.86 until the result is ≤ targetBytes (or quality reaches 0.5)
//   3. if the best result is still above maxBytes, shrink the image by 20% and try again (4 passes)
//   4. still above maxBytes → THROW. The caller must never fall back to uploading the original.
//
// An encoder that returns nothing, or a different format than asked for (a browser that cannot
// encode it), is a failure too — never silently accepted.

export interface Encoded { size: number; type: string }

export interface CompressionOptions {
  type:         string   // e.g. 'image/webp' or 'image/jpeg'
  maxDimension: number
  targetBytes:  number
  maxBytes:     number
}

export class GalleryCompressionError extends Error {
  constructor(message: string) { super(message); this.name = 'GalleryCompressionError' }
}

const QUALITIES = [0.86, 0.8, 0.74, 0.68, 0.62, 0.56, 0.5]
const PASSES = 4

export async function compressToBudget<B extends Encoded>(
  natural: { w: number; h: number },
  encode: (w: number, h: number, quality: number) => Promise<B | null>,
  opts: CompressionOptions,
): Promise<{ result: B; w: number; h: number; quality: number }> {
  const { w, h } = natural
  if (!(w > 0) || !(h > 0)) throw new GalleryCompressionError('This image could not be read.')
  let scale = Math.min(1, opts.maxDimension / Math.max(w, h))
  for (let pass = 0; pass < PASSES; pass++) {
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale))
    let best: { result: B; quality: number } | null = null
    for (const q of QUALITIES) {
      const out = await encode(cw, ch, q)
      if (!out || out.type !== opts.type) throw new GalleryCompressionError('This browser could not compress the image.')
      best = { result: out, quality: q }
      if (out.size <= opts.targetBytes) break
    }
    if (best && best.result.size <= opts.maxBytes) return { result: best.result, w: cw, h: ch, quality: best.quality }
    scale *= 0.8
  }
  throw new GalleryCompressionError(`This image could not be compressed below ${Math.round(opts.maxBytes / 1024)} KB.`)
}
