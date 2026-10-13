// RD-PRINT-P2 · Card dimensions — presets and custom sizes. PURE and isomorphic (no
// server imports), so the template form and the server validate with the same rules.
//
// A card's size is independent of the paper it is printed on. The only coupling is the
// upper bound: a card must fit on the largest supported sheet (A3, 297 × 420 mm) in at
// least one orientation, otherwise no print sheet can ever hold it. The lower bound keeps
// a card large enough to cut and handle.

import { CANVAS_PRESETS, type PrintCanvas, type CanvasUnit } from './types'

export const MM_PER_IN = 25.4
const MM_PER_PX = 25.4 / 96   // legacy px templates (CSS pixel at 96 dpi)

/** Smallest card side, in mm. */
export const CARD_MIN_MM       = 10
/** Largest card that still fits on A3 (297 × 420 mm) in some orientation. */
export const CARD_MAX_SHORT_MM = 297
export const CARD_MAX_LONG_MM  = 420

export function toMm(value: number, unit: CanvasUnit): number {
  return unit === 'in' ? value * MM_PER_IN : unit === 'px' ? value * MM_PER_PX : value
}

export function fromMm(mm: number, unit: CanvasUnit): number {
  return unit === 'in' ? mm / MM_PER_IN : unit === 'px' ? mm / MM_PER_PX : mm
}

/** The card's printed size in mm, honouring orientation (landscape swaps width/height). */
export function cardSizeMm(c: Pick<PrintCanvas, 'width' | 'height' | 'unit' | 'orientation'>): { w: number; h: number } {
  const w = toMm(c.width, c.unit), h = toMm(c.height, c.unit)
  return c.orientation === 'landscape' ? { w: h, h: w } : { w, h }
}

/**
 * A preset's dimensions are authoritative: a canvas that names a preset gets exactly the
 * preset's width, height and unit (orientation stays the caller's). CUSTOM is untouched.
 */
export function normalizePresetCanvas(c: PrintCanvas): PrintCanvas {
  if (c.preset === 'CUSTOM') return c
  const p = CANVAS_PRESETS[c.preset]
  return { preset: c.preset, width: p.width, height: p.height, unit: p.unit, orientation: c.orientation }
}

const fmt = (mm: number, unit: CanvasUnit) => {
  const v = fromMm(mm, unit)
  return `${Math.round(v * 100) / 100} ${unit}`
}

/** Why these dimensions cannot be a print card, or null when they can. */
export function cardDimensionProblem(c: Pick<PrintCanvas, 'width' | 'height' | 'unit'>): string | null {
  if (!Number.isFinite(c.width) || !Number.isFinite(c.height) || c.width <= 0 || c.height <= 0) {
    return 'Card width and height must be positive numbers.'
  }
  const a = toMm(c.width, c.unit), b = toMm(c.height, c.unit)
  const short = Math.min(a, b), long = Math.max(a, b)
  if (short < CARD_MIN_MM) {
    return `Card sides must be at least ${fmt(CARD_MIN_MM, c.unit)}.`
  }
  if (short > CARD_MAX_SHORT_MM || long > CARD_MAX_LONG_MM) {
    return `A card must fit on A3 paper: at most ${fmt(CARD_MAX_SHORT_MM, c.unit)} × ${fmt(CARD_MAX_LONG_MM, c.unit)}.`
  }
  return null
}

/**
 * RD-PRINT-AUDIT · whether two canvases describe the same card. The template edit form
 * sends the card size ONLY when this is false, so a metadata-only edit (name, status, …)
 * never re-validates — or re-versions — dimensions the user did not touch. Legacy
 * templates whose stored size predates today's limits stay renameable.
 */
export function sameCanvas(a: PrintCanvas, b: PrintCanvas): boolean {
  return a.preset === b.preset && a.unit === b.unit && a.orientation === b.orientation
    && Number(a.width) === Number(b.width) && Number(a.height) === Number(b.height)
}
