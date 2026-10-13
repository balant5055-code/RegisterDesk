// RD-PRINT-P2 — card dimensions, sheet layout and the sheet renderer. Pure / in-memory.
// Route, auth, pinning and storage behaviour on real emulators: tests/emulator/printSheets.emu.test.ts.

import { describe, it, expect } from 'vitest'
import zlib from 'node:zlib'
import { PDFDocument, PDFName, PDFDict, PDFRef, PDFArray, PDFRawStream } from 'pdf-lib'
import {
  toMm, fromMm, cardSizeMm, normalizePresetCanvas, cardDimensionProblem, CARD_MIN_MM,
} from '@/lib/printAssets/cardDimensions'
import {
  computeSheetLayout, validateSheetSpec, PAPER_MM, PT_PER_MM, CROP_MARK_REACH_MM,
  type SheetSpec, type SheetLayout,
} from '@/lib/printAssets/sheet/layout'
import { validateCreate, validateUpdate } from '@/lib/printAssets/validation'
import { PRINT_COLLECTIONS } from '@/lib/printAssets/collections'
import { normalizeDesign, renderSheetsToPdf, SheetBudgetError, RenderError } from '@/lib/printAssets/render'
import type { PrintCanvas } from '@/lib/printAssets/types'

const canvas = (o: Partial<PrintCanvas>): PrintCanvas => ({ preset: 'CUSTOM', width: 54, height: 85.6, unit: 'mm', orientation: 'portrait', ...o })

describe('card dimensions', () => {
  it('converts mm ↔ inches exactly and honours orientation', () => {
    expect(toMm(1, 'in')).toBe(25.4)
    expect(fromMm(25.4, 'in')).toBe(1)
    expect(toMm(3.375, 'in')).toBeCloseTo(85.725, 6)
    const inch = cardSizeMm(canvas({ width: 2.125, height: 3.375, unit: 'in' }))
    expect(inch.w).toBeCloseTo(53.975, 9)
    expect(inch.h).toBeCloseTo(85.725, 9)
    expect(cardSizeMm(canvas({ orientation: 'landscape' }))).toEqual({ w: 85.6, h: 54 })
  })
  it('a preset is authoritative: its width, height and unit win; orientation stays', () => {
    expect(normalizePresetCanvas(canvas({ preset: 'CR80', width: 999, height: 1, unit: 'in', orientation: 'landscape' })))
      .toEqual({ preset: 'CR80', width: 54, height: 85.6, unit: 'mm', orientation: 'landscape' })
    expect(normalizePresetCanvas(canvas({ preset: 'CUSTOM', width: 70, height: 100 }))).toMatchObject({ width: 70, height: 100 })
  })
  it('bounds: at least 10 mm a side, and must fit on A3 in some orientation — in any unit', () => {
    expect(cardDimensionProblem(canvas({}))).toBeNull()
    expect(cardDimensionProblem(canvas({ width: 297, height: 420 }))).toBeNull()               // exactly A3
    expect(cardDimensionProblem(canvas({ width: 420, height: 297 }))).toBeNull()
    expect(cardDimensionProblem(canvas({ width: CARD_MIN_MM - 0.1, height: 50 }))).toContain('at least 10 mm')
    expect(cardDimensionProblem(canvas({ width: 300, height: 300 }))).toContain('fit on A3')
    expect(cardDimensionProblem(canvas({ width: 10, height: 421 }))).toContain('fit on A3')
    expect(cardDimensionProblem(canvas({ width: 0.3, height: 2, unit: 'in' }))).toContain('in')  // 7.62 mm, reported in inches
    expect(cardDimensionProblem(canvas({ width: 11.69, height: 16.53, unit: 'in' }))).toBeNull() // just inside A3
    expect(cardDimensionProblem(canvas({ width: 11.7, height: 16.5, unit: 'in' }))).toContain('fit on A3')  // 297.18 mm > 297
    expect(cardDimensionProblem(canvas({ width: Number.NaN, height: 10 }))).toContain('positive')
  })
  it('template create/update enforce the bounds and normalise presets', () => {
    const base = { eventId: 'e', name: 'n', assetType: 'ID_CARD' }
    expect(validateCreate({ ...base, canvas: canvas({ width: 3.375, height: 2.125, unit: 'in' }) }).ok).toBe(true)
    expect(validateCreate({ ...base, canvas: canvas({ width: 5, height: 50 }) })).toMatchObject({ ok: false })
    expect(validateUpdate({ canvas: canvas({ width: 500, height: 500 }) })).toMatchObject({ ok: false })
    const p = validateCreate({ ...base, canvas: canvas({ preset: 'A6', width: 1, height: 1, unit: 'in' }) })
    expect(p.ok && p.value.canvas).toMatchObject({ preset: 'A6', width: 105, height: 148, unit: 'mm' })
  })
})

// ─── Layout ─────────────────────────────────────────────────────────────────────

const spec = (o: Partial<SheetSpec> = {}): SheetSpec => ({ paper: 'A4', orientation: 'portrait', marginMm: 10, gapMm: 4, cropMarks: false, ...o })
const mm = (pt: number) => pt / PT_PER_MM
const EPS = 1e-6

/** Every invariant a sheet must satisfy: inside the margins, no overlap, gaps kept, marks off the cards. */
function assertSound(l: SheetLayout, s: SheetSpec) {
  const m = s.marginMm * PT_PER_MM
  expect(l.slots).toHaveLength(l.cols * l.rows)
  for (const a of l.slots) {
    expect(a.x).toBeGreaterThanOrEqual(m - EPS)
    expect(a.y).toBeGreaterThanOrEqual(m - EPS)
    expect(a.x + l.cardW).toBeLessThanOrEqual(l.pageW - m + EPS)
    expect(a.y + l.cardH).toBeLessThanOrEqual(l.pageH - m + EPS)
  }
  // The slots form a full cols × rows grid whose consecutive column / row origins are at
  // least card + gap apart — which, for an axis-aligned grid, is exactly "no two cards
  // overlap and every gap is kept" (checked arithmetically: pairwise is O(n²) at 800+ slots).
  const g = s.gapMm * PT_PER_MM
  const xs = [...new Set(l.slots.map(a => a.x.toFixed(6)))].map(Number).sort((a, b) => a - b)
  const ys = [...new Set(l.slots.map(a => a.y.toFixed(6)))].map(Number).sort((a, b) => a - b)
  expect([xs.length, ys.length]).toEqual([l.cols, l.rows])
  for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(l.cardW + g - EPS)
  for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(l.cardH + g - EPS)
  const keys = new Set(l.slots.map(a => `${a.x.toFixed(6)},${a.y.toFixed(6)}`))
  expect(keys.size).toBe(l.slots.length)                                  // no slot used twice
  // The card grid's bounding box, computed once (not per mark — that was O(marks × slots)).
  const gx0 = Math.min(...l.slots.map(a => a.x)), gy0 = Math.min(...l.slots.map(a => a.y))
  const gx1 = Math.max(...l.slots.map(a => a.x)) + l.cardW, gy1 = Math.max(...l.slots.map(a => a.y)) + l.cardH
  for (const c of l.cropMarks) {
    for (const p of [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }]) {
      expect(p.x).toBeGreaterThanOrEqual(-EPS); expect(p.x).toBeLessThanOrEqual(l.pageW + EPS)
      expect(p.y).toBeGreaterThanOrEqual(-EPS); expect(p.y).toBeLessThanOrEqual(l.pageH + EPS)
    }
    // A mark segment never enters the card grid (every card lies inside the grid box).
    const minX = Math.min(c.x1, c.x2), maxX = Math.max(c.x1, c.x2), minY = Math.min(c.y1, c.y2), maxY = Math.max(c.y1, c.y2)
    const inside = maxX > gx0 + EPS && minX < gx1 - EPS && maxY > gy0 + EPS && minY < gy1 - EPS
    expect(inside, 'crop mark crosses the card grid').toBe(false)
  }
}

describe('sheet layout', () => {
  it('CR80 portrait on A4 portrait, 10 mm margins, 4 mm gap → 3 × 3, centred', () => {
    const r = computeSheetLayout({ w: 54, h: 85.6 }, spec())
    expect(r.ok && [r.layout.cols, r.layout.rows]).toEqual([3, 3])
    if (!r.ok) return
    expect(mm(r.layout.pageW)).toBeCloseTo(210, 6)
    expect(mm(r.layout.pageH)).toBeCloseTo(297, 6)
    const left = mm(r.layout.slots[0].x), right = 210 - mm(r.layout.slots[2].x) - 54
    expect(left).toBeCloseTo(right, 6)                                                        // centred
    assertSound(r.layout, spec())
  })
  it('A3 and landscape change the grid, never the card', () => {
    const a3 = computeSheetLayout({ w: 54, h: 85.6 }, spec({ paper: 'A3' }))
    const a4l = computeSheetLayout({ w: 54, h: 85.6 }, spec({ orientation: 'landscape' }))
    expect(a3.ok && [a3.layout.cols, a3.layout.rows]).toEqual([4, 4])
    expect(a4l.ok && [a4l.layout.cols, a4l.layout.rows]).toEqual([4, 2])
    if (a3.ok) expect(mm(a3.layout.cardW)).toBeCloseTo(54, 6)
  })
  it('a card that does not fit is an error, never shrunk', () => {
    const r = computeSheetLayout({ w: 210, h: 297 }, spec())
    expect(r).toMatchObject({ ok: false, code: 'CARD_TOO_LARGE' })
    expect(computeSheetLayout({ w: 210, h: 297 }, spec({ marginMm: 0 }))).toMatchObject({ ok: true })   // exactly A4
    expect(computeSheetLayout({ w: 297, h: 420 }, spec({ paper: 'A3', marginMm: 0 }))).toMatchObject({ ok: true })
  })
  it('crop marks need margins of at least the mark reach, and stay in the margins', () => {
    expect(computeSheetLayout({ w: 54, h: 85.6 }, spec({ cropMarks: true, marginMm: CROP_MARK_REACH_MM - 0.5 })))
      .toMatchObject({ ok: false, code: 'MARGIN_TOO_SMALL_FOR_CROP_MARKS' })
    const r = computeSheetLayout({ w: 54, h: 85.6 }, spec({ cropMarks: true, gapMm: 0 }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // gap 0: adjacent cards share a cutting line, so 3 columns have 4 distinct x edges and
    // 3 rows 4 distinct y edges; each edge gets a mark on both sides of the grid.
    expect(r.layout.cropMarks.length).toBe(4 * 2 + 4 * 2)
    const gapped = computeSheetLayout({ w: 54, h: 85.6 }, spec({ cropMarks: true, gapMm: 4 }))
    expect(gapped.ok && gapped.layout.cropMarks.length).toBe(6 * 2 + 6 * 2)                   // 6 distinct edges each way
    assertSound(r.layout, spec({ cropMarks: true, gapMm: 0 }))
  })
  it('no overlap or clipping across many card sizes, papers, orientations, margins, gaps and crop marks', () => {
    let checked = 0
    for (const card of [{ w: 10, h: 10 }, { w: 54, h: 85.6 }, { w: 85.6, h: 54 }, { w: 100, h: 60 }, { w: 105, h: 148 }, { w: 148, h: 210 }, { w: 53.975, h: 85.725 }, { w: 297, h: 420 }]) {
      for (const paper of ['A4', 'A3'] as const) for (const orientation of ['portrait', 'landscape'] as const)
        for (const marginMm of [0, 4, 10, 25]) for (const gapMm of [0, 2, 5]) for (const cropMarks of [false, true]) {
          const s = spec({ paper, orientation, marginMm, gapMm, cropMarks })
          const r = computeSheetLayout(card, s)
          if (!r.ok) {
            const page = PAPER_MM[paper], pw = orientation === 'landscape' ? page.h : page.w, ph = orientation === 'landscape' ? page.w : page.h
            const fits = card.w <= pw - 2 * marginMm + EPS && card.h <= ph - 2 * marginMm + EPS
            expect(r.code === 'MARGIN_TOO_SMALL_FOR_CROP_MARKS' || !fits, `${JSON.stringify({ card, s })} refused but fits`).toBe(true)
            continue
          }
          assertSound(r.layout, s)
          checked++
        }
    }
    expect(checked).toBeGreaterThan(200)
  }, 30_000)
  it('validates sheet specs from untrusted input', () => {
    expect(validateSheetSpec(undefined)).toMatchObject({ ok: true, value: { paper: 'A4', marginMm: 10, gapMm: 4, cropMarks: false } })
    expect(validateSheetSpec({ paper: 'Letter' })).toMatchObject({ ok: false })
    expect(validateSheetSpec({ orientation: 'diagonal' })).toMatchObject({ ok: false })
    expect(validateSheetSpec({ marginMm: -1 })).toMatchObject({ ok: false })
    expect(validateSheetSpec({ gapMm: 51 })).toMatchObject({ ok: false })
    expect(validateSheetSpec({ marginMm: 'abc' })).toMatchObject({ ok: false })
    expect(validateSheetSpec({ paper: 'A3', orientation: 'landscape', marginMm: '6', gapMm: 0, cropMarks: true }))
      .toEqual({ ok: true, value: { paper: 'A3', orientation: 'landscape', marginMm: 6, gapMm: 0, cropMarks: true } })
  })
})

// ─── Renderer ───────────────────────────────────────────────────────────────────

function png(w: number, h: number): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = x & 255; raw[o + 1] = y & 255; raw[o + 2] = 120; raw[o + 3] = 255 }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

describe('sheet renderer (branded cards: logo + QR + text)', () => {
  const LOGO = 'https://firebasestorage.googleapis.com/v0/b/demo/o/organizer-assets%2Fu%2Flogo.png?alt=media'
  const badge = PRINT_COLLECTIONS.flatMap(c => c.templates).find(t => t.name === 'Runner Badge')!
  const design = { ...badge.design, elements: [...badge.design.elements, { id: 'logo', type: 'image', x: 0.06, y: 0.82, width: 0.4, height: 0.14, rotation: 0, visible: true, locked: false, zIndex: 50, properties: { text: '{{logo}}', fit: 'contain' } }] }
  const doc = normalizeDesign(badge.canvas, design as never, {})
  const assets = new Map([[LOGO, png(240, 120)]])
  const card = (i: number) => ({
    registration: { name: `Dr. Anjali Venkataraman-Iyer ${i}`, ticket: `RD-2026-${100000 + i}`, id: `r${i}`, company: 'Sundaram Biotech Private Limited' },
    event: { name: 'International Conference on Sustainable Futures 2026' }, pass: { label: 'Full Conference Delegate' },
    system: { qr: `RD:ev:r${i}:RD-2026-${100000 + i}` }, branding: { logo: LOGO, company: 'RegisterDesk Events' },
  }) as never
  const layoutFor = (s: SheetSpec) => { const r = computeSheetLayout(cardSizeMm(badge.canvas), s); if (!r.ok) throw new Error(r.error); return r.layout }

  it('puts N cards on ceil(N / perSheet) pages of the paper size, clipping each card, embedding the logo ONCE', async () => {
    const layout = layoutFor(spec({ cropMarks: true }))
    const N = 20
    const { bytes, sheets } = await renderSheetsToPdf({ document: doc, cards: Array.from({ length: N }, (_, i) => card(i)), assets, layout })
    expect(sheets).toBe(Math.ceil(N / layout.perSheet))
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBe(sheets)
    for (const p of pdf.getPages()) {
      expect(mm(p.getWidth())).toBeCloseTo(210, 3)
      expect(mm(p.getHeight())).toBeCloseTo(297, 3)
    }
    // Images used by every page: the same single embedded object.
    const imageRefs = new Set<string>()
    for (const p of pdf.getPages()) {
      const xo = p.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
      for (const [, ref] of xo?.entries() ?? []) if (ref instanceof PDFRef) imageRefs.add(ref.toString())
    }
    expect(imageRefs.size).toBe(1)
    // One clip per card ("… re W n"), read from the (deflated) page content streams.
    let clips = 0
    for (const p of pdf.getPages()) {
      const c = p.node.Contents()
      const streams = c instanceof PDFArray ? c.asArray().map(r => pdf.context.lookup(r)) : [c]
      for (const st of streams) {
        if (!(st instanceof PDFRawStream)) continue
        const raw = Buffer.from(st.contents)
        const filter = st.dict.get(PDFName.of('Filter'))
        const text = (filter?.toString() === '/FlateDecode' ? zlib.inflateSync(raw) : raw).toString('latin1')
        clips += text.match(/re\s+W\s+n/g)?.length ?? 0
      }
    }
    expect(clips).toBe(N)
  })

  it('a branded card on a sheet costs far less than its own PDF (logo shared)', async () => {
    const layout = layoutFor(spec())
    const one   = await renderSheetsToPdf({ document: doc, cards: [card(0)], assets, layout })
    const fifty = await renderSheetsToPdf({ document: doc, cards: Array.from({ length: 50 }, (_, i) => card(i)), assets, layout })
    const perCard = (fifty.bytes.length - one.bytes.length) / 49
    expect(perCard).toBeLessThan(12_000)                                 // measured ≈ 6 KB
    expect(one.bytes.length).toBeGreaterThan(perCard)                    // the logo is paid once
  })

  it('refuses a layout computed for another card size, and stops at the deadline', async () => {
    const wrong = computeSheetLayout({ w: 100, h: 60 }, spec())
    if (!wrong.ok) throw new Error('fixture')
    await expect(renderSheetsToPdf({ document: doc, cards: [card(0)], assets, layout: wrong.layout })).rejects.toBeInstanceOf(RenderError)
    await expect(renderSheetsToPdf({ document: doc, cards: [card(0), card(1)], assets, layout: layoutFor(spec()), deadline: Date.now() - 1 }))
      .rejects.toBeInstanceOf(SheetBudgetError)
  })
})
