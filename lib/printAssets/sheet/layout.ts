// RD-PRINT-P2 · Print-sheet layout. PURE and isomorphic — the server renders from it and
// the UI previews "N cards per sheet" from the SAME numbers.
//
// Cards keep their own size (independent of the paper). A sheet is the paper minus its
// margins; cards are placed in a grid with a fixed gap between them, and the grid is
// centred in the printable area. Nothing is ever scaled or rotated to fit: a card that
// does not fit on the chosen paper is an ERROR, never a shrunken card.
//
// Crop marks are cutting guides drawn ONLY in the sheet margins, aligned with every card
// edge — never between cards — so they cannot overlap a card at any gap, including 0.
// They need the margin to be at least CROP_MARK_REACH_MM deep.
//
// All geometry is in POINTS with a TOP-LEFT origin (y down), like the card renderer.

export type PaperSize = 'A4' | 'A3'
export type PaperOrientation = 'portrait' | 'landscape'

export const PAPER_SIZES: readonly PaperSize[] = ['A4', 'A3']
export const PAPER_MM: Record<PaperSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
}

export const PT_PER_MM = 72 / 25.4

/** Crop mark geometry: a mark starts CROP_MARK_OFFSET_MM outside the grid and is CROP_MARK_LENGTH_MM long. */
export const CROP_MARK_OFFSET_MM = 1
export const CROP_MARK_LENGTH_MM = 3
export const CROP_MARK_REACH_MM  = CROP_MARK_OFFSET_MM + CROP_MARK_LENGTH_MM

export const SHEET_MARGIN_MAX_MM = 50
export const SHEET_GAP_MAX_MM    = 50

export interface SheetSpec {
  paper:       PaperSize
  orientation: PaperOrientation
  marginMm:    number
  gapMm:       number
  cropMarks:   boolean
}

export const DEFAULT_SHEET_SPEC: SheetSpec = { paper: 'A4', orientation: 'portrait', marginMm: 10, gapMm: 4, cropMarks: false }

export type SheetSpecResult = { ok: true; value: SheetSpec } | { ok: false; error: string }

/** Validate a sheet spec from untrusted input. Missing fields take the defaults. */
export function validateSheetSpec(raw: unknown): SheetSpecResult {
  const b = (raw ?? {}) as Record<string, unknown>
  const paper = b.paper ?? DEFAULT_SHEET_SPEC.paper
  if (typeof paper !== 'string' || !(PAPER_SIZES as readonly string[]).includes(paper)) {
    return { ok: false, error: 'Paper must be A4 or A3.' }
  }
  const orientation = b.orientation ?? DEFAULT_SHEET_SPEC.orientation
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    return { ok: false, error: 'Paper orientation must be portrait or landscape.' }
  }
  const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : typeof v === 'number' ? v : Number(v))
  const marginMm = num(b.marginMm, DEFAULT_SHEET_SPEC.marginMm)
  const gapMm    = num(b.gapMm, DEFAULT_SHEET_SPEC.gapMm)
  if (!Number.isFinite(marginMm) || marginMm < 0 || marginMm > SHEET_MARGIN_MAX_MM) {
    return { ok: false, error: `Margins must be between 0 and ${SHEET_MARGIN_MAX_MM} mm.` }
  }
  if (!Number.isFinite(gapMm) || gapMm < 0 || gapMm > SHEET_GAP_MAX_MM) {
    return { ok: false, error: `The gap between cards must be between 0 and ${SHEET_GAP_MAX_MM} mm.` }
  }
  const cropMarks = b.cropMarks === true || b.cropMarks === 'true' || b.cropMarks === '1'
  return { ok: true, value: { paper: paper as PaperSize, orientation, marginMm, gapMm, cropMarks } }
}

export interface SheetSlot { x: number; y: number }          // card top-left, in points
export interface CropMark  { x1: number; y1: number; x2: number; y2: number }

export interface SheetLayout {
  pageW:    number             // points
  pageH:    number
  cardW:    number
  cardH:    number
  cols:     number
  rows:     number
  perSheet: number
  slots:    SheetSlot[]        // perSheet entries, row-major
  cropMarks: CropMark[]        // empty when crop marks are off
}

export type SheetLayoutResult =
  | { ok: true; layout: SheetLayout }
  | { ok: false; code: 'CARD_TOO_LARGE' | 'MARGIN_TOO_SMALL_FOR_CROP_MARKS'; error: string }

const EPS = 1e-6
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Lay cards of `cardMm` (already oriented) onto the sheet. Deterministic; never scales.
 */
export function computeSheetLayout(cardMm: { w: number; h: number }, spec: SheetSpec): SheetLayoutResult {
  const paper = PAPER_MM[spec.paper]
  const pageMm = spec.orientation === 'landscape' ? { w: paper.h, h: paper.w } : { w: paper.w, h: paper.h }

  if (spec.cropMarks && spec.marginMm + EPS < CROP_MARK_REACH_MM) {
    return {
      ok: false, code: 'MARGIN_TOO_SMALL_FOR_CROP_MARKS',
      error: `Crop marks need margins of at least ${CROP_MARK_REACH_MM} mm.`,
    }
  }

  const availW = pageMm.w - 2 * spec.marginMm
  const availH = pageMm.h - 2 * spec.marginMm
  const cols = Math.floor((availW + spec.gapMm + EPS) / (cardMm.w + spec.gapMm))
  const rows = Math.floor((availH + spec.gapMm + EPS) / (cardMm.h + spec.gapMm))
  if (cols < 1 || rows < 1) {
    return {
      ok: false, code: 'CARD_TOO_LARGE',
      error: `A ${round2(cardMm.w)} × ${round2(cardMm.h)} mm card does not fit on ${spec.paper} ${spec.orientation} paper with ${spec.marginMm} mm margins. Use larger paper, the other orientation or smaller margins.`,
    }
  }

  const gridW = cols * cardMm.w + (cols - 1) * spec.gapMm
  const gridH = rows * cardMm.h + (rows - 1) * spec.gapMm
  const left  = spec.marginMm + (availW - gridW) / 2
  const top   = spec.marginMm + (availH - gridH) / 2
  const pt    = (mm: number) => mm * PT_PER_MM

  const slots: SheetSlot[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      slots.push({ x: pt(left + c * (cardMm.w + spec.gapMm)), y: pt(top + r * (cardMm.h + spec.gapMm)) })
    }
  }

  const cropMarks: CropMark[] = []
  if (spec.cropMarks) {
    const o = CROP_MARK_OFFSET_MM, l = CROP_MARK_LENGTH_MM
    const right = left + gridW, bottom = top + gridH
    const xs = new Set<number>(), ys = new Set<number>()
    for (let c = 0; c < cols; c++) { xs.add(left + c * (cardMm.w + spec.gapMm)); xs.add(left + c * (cardMm.w + spec.gapMm) + cardMm.w) }
    for (let r = 0; r < rows; r++) { ys.add(top + r * (cardMm.h + spec.gapMm)); ys.add(top + r * (cardMm.h + spec.gapMm) + cardMm.h) }
    for (const x of xs) {   // vertical ticks above and below the grid
      cropMarks.push({ x1: pt(x), y1: pt(top - o - l), x2: pt(x), y2: pt(top - o) })
      cropMarks.push({ x1: pt(x), y1: pt(bottom + o), x2: pt(x), y2: pt(bottom + o + l) })
    }
    for (const y of ys) {   // horizontal ticks left and right of the grid
      cropMarks.push({ x1: pt(left - o - l), y1: pt(y), x2: pt(left - o), y2: pt(y) })
      cropMarks.push({ x1: pt(right + o), y1: pt(y), x2: pt(right + o + l), y2: pt(y) })
    }
  }

  return {
    ok: true,
    layout: {
      pageW: pt(pageMm.w), pageH: pt(pageMm.h), cardW: pt(cardMm.w), cardH: pt(cardMm.h),
      cols, rows, perSheet: cols * rows, slots, cropMarks,
    },
  }
}
