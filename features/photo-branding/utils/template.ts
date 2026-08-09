'use client'

// RD-PHOTO-01 · Downloadable design templates.
//
// GENERATED from the spec, never a checked-in asset. A template file living in `public/`
// describes the rules at the moment someone exported it; this one cannot drift, because the
// same `specFor()` that validates an upload draws the guides.
//
// ─── Extensibility ───────────────────────────────────────────────────────────
// `buildTemplate*` takes a style. Adding a template for a future style is the same call with
// a different spec entry — no new file, no new route, no new asset to maintain.
//
// DOM-only (the PNG needs a Canvas). Never imported by a server module.

import { safeArea, specFor, type BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'

/**
 * An SVG template.
 *
 * Vector, so it opens in Figma, Illustrator, Affinity or Inkscape at any size, and the guide
 * layer is editable rather than baked into pixels. This is the honest answer to "PSD and
 * Figma templates" — those are proprietary binary formats this platform cannot author, and
 * shipping a stale binary would be worse than shipping a live vector.
 */
export function buildTemplateSvg(style: BrandingStyle): Blob {
  const spec = specFor(style)
  const W = spec.recommendedWidth
  const H = spec.recommendedHeight
  const safe = safeArea(spec, W, H)

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>RegisterDesk branding overlay template — ${spec.label}</title>
  <desc>Artboard ${W}x${H}. Keep logos and text inside the safe area. Export as PNG with a transparent background (RGBA). Delete the guide layer before exporting.</desc>

  <!-- GUIDES — delete this group before exporting -->
  <g id="registerdesk-guides" opacity="0.55">
    <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#94a3b8" stroke-width="4" stroke-dasharray="16 10"/>
    <rect x="${safe.x}" y="${safe.y}" width="${safe.width}" height="${safe.height}"
          fill="none" stroke="#2563eb" stroke-width="4" stroke-dasharray="18 12"/>
    <text x="${W / 2}" y="${safe.y - 14}" text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="24" fill="#2563eb">
      Safe area — ${safe.width} x ${safe.height} px
    </text>
    <text x="${W / 2}" y="${H - 18}" text-anchor="middle"
          font-family="system-ui, sans-serif" font-size="22" fill="#94a3b8">
      Artboard ${W} x ${H} px — transparent background — delete guides before export
    </text>
  </g>

  <!-- YOUR ARTWORK GOES HERE -->
  <g id="artwork"></g>
</svg>`

  return new Blob([svg], { type: 'image/svg+xml' })
}

/**
 * A PNG template at the exact recommended size, with a transparent background.
 *
 * Drawn on a Canvas so the file an organizer opens is genuinely RGBA — the same thing they
 * must hand back. A JPEG-flattened guide would teach exactly the wrong habit.
 */
export async function buildTemplatePng(style: BrandingStyle): Promise<Blob> {
  const spec = specFor(style)
  const W = spec.recommendedWidth
  const H = spec.recommendedHeight
  const safe = safeArea(spec, W, H)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H

  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('This browser could not create a drawing surface.')

  // Nothing is painted as a background: the canvas starts fully transparent, which is the
  // whole point of the template.
  ctx.strokeStyle = '#94a3b8'
  ctx.lineWidth = 4
  ctx.setLineDash([16, 10])
  ctx.strokeRect(2, 2, W - 4, H - 4)

  ctx.strokeStyle = '#2563eb'
  ctx.setLineDash([18, 12])
  ctx.strokeRect(safe.x, safe.y, safe.width, safe.height)

  ctx.setLineDash([])
  ctx.fillStyle = '#2563eb'
  ctx.font = '600 24px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`Safe area — ${safe.width} × ${safe.height} px`, W / 2, safe.y - 14)

  ctx.fillStyle = '#94a3b8'
  ctx.font = '22px system-ui, sans-serif'
  ctx.fillText(
    `${W} × ${H} px — transparent background — remove these guides before exporting`,
    W / 2, H - 18,
  )

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The template could not be generated.')
  return blob
}
