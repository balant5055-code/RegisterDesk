// RD-PHOTO-01 · The artwork specification.
//
// PURE. No SDK, no DOM, no I/O.
//
// ═══ ONE SOURCE FOR THE NUMBERS ═══════════════════════════════════════════════
// The requirements an organizer reads on the page, the rules the validator enforces, the
// safe-area illustration, and the downloadable template are all generated from THIS file.
// A spec that lives in prose and again in a validator drifts the first time either changes,
// and the organizer only finds out when a carefully-made overlay is rejected.
// ══════════════════════════════════════════════════════════════════════════════
//
// ─── Future compatibility ────────────────────────────────────────────────────
// `BrandingStyle` is a union with ONE member today. Full frame, watermark, corner logo,
// sponsor strip, finisher frame and VIP branding are named in `PLANNED_STYLES` so the shape
// of the extension is fixed — each will add a spec entry and a placement rule, and nothing
// else. None is implemented, by instruction.

/** How an overlay is placed over a photo. */
export type BrandingStyle = 'bottom-banner'

export const BRANDING_STYLES: readonly BrandingStyle[] = ['bottom-banner']

export function isBrandingStyle(v: unknown): v is BrandingStyle {
  return typeof v === 'string' && (BRANDING_STYLES as readonly string[]).includes(v)
}

/**
 * Styles the architecture is shaped for but does NOT implement.
 *
 * Listed so the extension point is explicit rather than implied. Adding one means an entry
 * in `SPECS` plus a case in `placeOverlay` — no schema change, no new collection, no change
 * to upload, storage or download.
 */
export const PLANNED_STYLES = [
  'full-frame', 'watermark', 'corner-logo', 'sponsor-strip', 'finisher-frame', 'vip',
] as const

export interface ArtworkSpec {
  style: BrandingStyle
  label: string
  /** Where the artwork sits on the photo. */
  position: string

  /** The size an organizer should design at. */
  recommendedWidth:  number
  recommendedHeight: number
  minWidth:  number
  minHeight: number
  maxWidth:  number
  maxHeight: number

  maxBytes: number
  /** Print resolution to design at. Advisory — PNG carries no reliable DPI. */
  recommendedDpi: number

  /**
   * Fraction of the photo's height the banner occupies when composited.
   *
   * 0.19 sits inside the 18–20% band the guidelines recommend, and is what the live preview
   * and the real download both use — so the preview is not an approximation.
   */
  heightRatio: number

  /** Inset from every edge that must stay clear of important content, as a fraction. */
  safeAreaInset: number
}

const MB = 1024 * 1024

const BOTTOM_BANNER: ArtworkSpec = {
  style: 'bottom-banner',
  label: 'Bottom banner',
  position: 'Bottom of the photo, full width',

  recommendedWidth:  2048,
  recommendedHeight: 360,
  minWidth:  1600,
  minHeight: 280,
  maxWidth:  4096,
  maxHeight: 720,

  maxBytes: 2 * MB,
  recommendedDpi: 300,

  heightRatio:   0.19,
  safeAreaInset: 0.08,
}

const SPECS: Readonly<Record<BrandingStyle, ArtworkSpec>> = {
  'bottom-banner': BOTTOM_BANNER,
}

export function specFor(style: BrandingStyle): ArtworkSpec {
  return SPECS[style] ?? BOTTOM_BANNER
}

export const DEFAULT_STYLE: BrandingStyle = 'bottom-banner'

// ─── Derived, so the page and the validator cannot disagree ───────────────────

/** `2048 × 360 px` */
export function formatDimensions(w: number, h: number): string {
  return `${w.toLocaleString('en-IN')} × ${h.toLocaleString('en-IN')} px`
}

/** `2 MB` */
export function formatBytes(bytes: number): string {
  const mb = bytes / MB
  return mb >= 1 ? `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
}

/** The aspect ratio an organizer should design to, e.g. 5.69 for 2048×360. */
export function recommendedAspect(spec: ArtworkSpec): number {
  return spec.recommendedWidth / spec.recommendedHeight
}

/**
 * How far an uploaded overlay may stray from the recommended aspect ratio.
 *
 * Generous on purpose. The banner is scaled to the photo's width on composite, so a
 * moderately different ratio still renders correctly — it only changes how tall the band is.
 * Rejecting a 2048×340 file for being 6% off would be pedantry, not protection.
 */
export const ASPECT_TOLERANCE = 0.35

/** The safe area, in the overlay's own pixels. Drives the illustration and the template. */
export function safeArea(spec: ArtworkSpec, width: number, height: number) {
  const insetX = Math.round(width * spec.safeAreaInset)
  const insetY = Math.round(height * spec.safeAreaInset)
  return {
    x: insetX,
    y: insetY,
    width:  Math.max(1, width  - insetX * 2),
    height: Math.max(1, height - insetY * 2),
  }
}
