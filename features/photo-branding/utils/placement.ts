// RD-PHOTO-01 · Where an overlay sits on a photo.
//
// PURE. No SDK, no DOM, no I/O — so the live preview and the real download provably agree,
// and a future style is a case in one switch rather than a change to the compositor.
//
// ═══ THE EXTENSION POINT ══════════════════════════════════════════════════════
// Full frame, watermark, corner logo, sponsor strip, finisher frame and VIP branding are all
// "put this artwork at these coordinates". Each becomes one branch here plus a spec entry —
// no schema change, no new collection, and no change to upload, storage or download.
// None is implemented, by instruction.
// ══════════════════════════════════════════════════════════════════════════════

import { specFor, type BrandingStyle } from '@/features/photo-branding/utils/artworkSpec'

export interface PlacementInput {
  style:         BrandingStyle
  photoWidth:    number
  photoHeight:   number
  overlayWidth:  number
  overlayHeight: number
}

export interface PlacementBox {
  x:      number
  y:      number
  width:  number
  height: number
}

/**
 * The rectangle the overlay is drawn into, in photo pixels.
 *
 * For a bottom banner: full width, flush to the bottom, height taken from the OVERLAY'S OWN
 * aspect ratio and then capped by the style's `heightRatio`.
 *
 * Using the artwork's ratio rather than forcing the spec's means a banner designed slightly
 * taller or shorter renders undistorted — it just occupies a little more or less of the
 * frame. The cap stops an unusually tall file from swallowing a third of the photograph.
 *
 * ─── A tension worth knowing about ───────────────────────────────────────────
 * The two numbers the specification gives are in mild conflict. A 2048×360 banner stretched
 * across a 3000×2000 photo is naturally 527px tall — 26% of the frame, above the 18–20%
 * band the design guidance recommends. So for the RECOMMENDED size on the most common photo
 * shape the cap engages, and the banner is compressed vertically by about a fifth.
 *
 * That is the safer failure: a banner slightly shorter than designed reads fine, whereas one
 * covering a quarter of the photograph does not. Artwork nearer 2048×250 (8.2:1) fills the
 * band exactly and is never compressed — which is why the guidance leads with the band.
 */
export function placeOverlay(input: PlacementInput): PlacementBox {
  const spec = specFor(input.style)

  const width = input.photoWidth

  // Guard against a zero-width overlay: dividing by it would yield Infinity and draw nothing.
  const naturalHeight = input.overlayWidth > 0
    ? Math.round(width * (input.overlayHeight / input.overlayWidth))
    : Math.round(input.photoHeight * spec.heightRatio)

  const maxHeight = Math.round(input.photoHeight * spec.heightRatio)
  const height = Math.max(1, Math.min(naturalHeight, maxHeight))

  return {
    x: 0,
    y: Math.max(0, input.photoHeight - height),
    width,
    height,
  }
}

/**
 * The same box as CSS percentages, for the live preview.
 *
 * The preview renders the overlay as a positioned element over an `<img>` rather than
 * re-running the compositor on every keystroke — but it derives its position from THIS
 * function, so what an organizer sees is what a download produces.
 */
export function placementAsPercent(input: PlacementInput) {
  const box = placeOverlay(input)
  const pct = (n: number, of: number) => (of > 0 ? (n / of) * 100 : 0)
  return {
    left:   `${pct(box.x, input.photoWidth)}%`,
    top:    `${pct(box.y, input.photoHeight)}%`,
    width:  `${pct(box.width, input.photoWidth)}%`,
    height: `${pct(box.height, input.photoHeight)}%`,
  }
}
