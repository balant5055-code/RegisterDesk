// PA-3 — Print rendering engine (server-only entry point).
//
//   RenderDocument + resolved variables
//     → validate (schema / canvas / coordinates)
//     → layout (fractions → points)
//     → element renderer (frozen tier order)
//     → PDF (pdf-lib)  and/or  SVG preview  (same DrawTarget pipeline)
//
// The renderer NEVER queries Firestore: variable values arrive pre-resolved.
// No jobs, no storage, no downloads, no batching — just JSON → document.

import {
  PDFDocument, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  rectangle, clip, endPath, type PDFImage,
} from 'pdf-lib'
import type { SheetLayout } from '@/lib/printAssets/sheet/layout'
import { buildFontSet } from '@/lib/certificates/fonts'
import { validateRenderDocument } from './validate'
import {
  pageSizeOf, type PageSize, type RenderDocument,
} from './types'
import {
  elementBox, fontSizePt, borderWidthPt, radiusPt, thicknessPt, orderedForPaint, opacityOf,
} from './layout'
import { layoutText, wrapText } from './geometry'
import {
  PdfTarget, SvgTarget, createMeasurer, type DrawTarget,
} from './target'
import { buildVariableMap, resolvePrintText, type PrintVariableSources } from './variables'
import type { PrintAssetMap } from './assets'

export class RenderError extends Error {}

export interface RenderInput {
  document:  RenderDocument
  variables: PrintVariableSources
  /** Pre-fetched image bytes by URL (PA-5). The renderer NEVER fetches URLs. */
  assets?:   PrintAssetMap
}

type Measure = (s: string, sizePt: number, weight: 'normal' | 'bold') => number

// ─── The single element loop (shared by both backends) ──────────────────────────

async function paint(
  target: DrawTarget, doc: RenderDocument, page: PageSize,
  measure: Measure, varMap: Map<string, string>, assets?: PrintAssetMap,
): Promise<void> {
  // 1. Background.
  target.fillBackground(doc.canvas.background)

  // 2..N. Elements in the FROZEN tier order (rect → line → image → qr → text).
  for (const el of orderedForPaint(doc.elements)) {
    const box = elementBox(el, page)
    const opacity = opacityOf(el)
    const pr = el.properties

    switch (el.type) {
      case 'rect':
        target.rect(box, {
          fill:          pr.fill,
          stroke:        (pr.borderWidth ?? 0) > 0 ? (pr.borderColor ?? '#9ca3af') : undefined,
          strokeWidthPt: borderWidthPt(pr.borderWidth, page),
          radiusPt:      radiusPt(pr.radius, page),
          opacity,
        })
        break

      case 'line': {
        const th = thicknessPt(pr.thickness, page)
        const box2 = pr.orientation === 'vertical'
          ? { x: box.x + (box.w - th) / 2, y: box.y, w: th, h: box.h, rotation: box.rotation }
          : { x: box.x, y: box.y + (box.h - th) / 2, w: box.w, h: th, rotation: box.rotation }
        target.rect(box2, { fill: pr.color ?? '#9ca3af', opacity })
        break
      }

      case 'image': {
        // Source is a variable token or URL in `properties.text`; bytes come ONLY
        // from the pre-fetched asset map — the renderer never fetches.
        const src = resolvePrintText(pr.text ?? '', varMap).trim()
        if (!src) break
        const bytes = assets?.get(src)
        if (!bytes) break   // missing/blocked asset → draw nothing (no placeholder)
        await target.image(box, { bytes, contentType: '', fit: pr.fit ?? 'contain', opacity })
        break
      }

      case 'qr': {
        // Encodes the resolved value (defaults to {{qr}} = the registration QR payload).
        const value = resolvePrintText(pr.text || '{{qr}}', varMap).trim()
        if (!value) break
        target.qr(box, { value, dark: pr.color ?? '#000000', opacity })
        break
      }

      case 'barcode': {
        // 1-D barcode (Code128 / EAN-13). Value resolves from the token in `text`
        // (defaults to {{ticket}}); an unencodable value draws nothing.
        const value = resolvePrintText(pr.text || '{{ticket}}', varMap).trim()
        if (!value) break
        target.barcode(box, { value, format: pr.barcodeFormat === 'ean13' ? 'ean13' : 'code128', dark: pr.color ?? '#000000', opacity })
        break
      }

      case 'text': {
        const resolved = resolvePrintText(pr.text ?? '', varMap)
        if (!resolved) break
        const fs      = fontSizePt(el, page)
        const weight  = pr.fontWeight === 'bold' ? 'bold' : 'normal'
        const measFn  = (s: string) => measure(s, fs, weight)
        const lines   = wrapText(resolved, measFn, box.w)
        const spec    = {
          lines, fontSizePt: fs, align: pr.align ?? 'center',
          lineHeightPt:    fs * (pr.lineHeight ?? 1.2),
          letterSpacingPt: (pr.letterSpacing ?? 0) * fs,   // em → pt
        }
        const positioned = layoutText(box, spec, measFn)
        const family = pr.fontFamily === 'times' || pr.fontFamily === 'courier' ? pr.fontFamily : 'helvetica'
        await target.text(box, positioned, {
          fontSizePt: fs, fontFamily: family, weight, color: pr.color ?? '#111827', opacity,
          letterSpacingPt: spec.letterSpacingPt,
        })
        break
      }
    }
  }

  // Foreground: the canvas border frame, drawn last so it stays crisp.
  target.canvasBorder(doc.canvas.borderColor, borderWidthPt(doc.canvas.borderWidth, page))
}

// ─── Public renderers ─────────────────────────────────────────────────────────

function prepare(document: RenderDocument): { doc: RenderDocument; page: PageSize } {
  const v = validateRenderDocument(document)
  if (!v.ok) throw new RenderError(v.error)
  return { doc: v.document, page: pageSizeOf(v.document.canvas) }
}

/** Render to a PDF document (Uint8Array). Reuses the certificate font registry. */
export async function renderToPdf(input: RenderInput): Promise<Uint8Array> {
  const { doc, page } = prepare(input.document)
  const pdf   = await PDFDocument.create()
  const pg    = pdf.addPage([page.width, page.height])
  const fonts = await buildFontSet(pdf)
  const measure = await createMeasurer()
  const target  = new PdfTarget(pdf, pg, fonts, page.width, page.height)
  await paint(target, doc, page, measure, buildVariableMap(input.variables), input.assets)
  return pdf.save()
}

// ─── Print sheets (RD-PRINT-P2) ─────────────────────────────────────────────────
//
// Many cards DIRECTLY onto paper-sized pages — never one PDF per attendee embedded into
// sheets. One document, one font set, one measurer and one image-embed cache for every
// card, so a logo on 500 cards is embedded once. Each card is painted by the SAME
// `paint` loop as a single card, inside a graphics state that translates the card-space
// origin to its slot and CLIPS to the card's trim box: nothing a card draws can reach a
// neighbouring card or the margin. Nothing is written anywhere — bytes are returned.

export class SheetBudgetError extends RenderError {}

export interface SheetRenderInput {
  document: RenderDocument
  /** One entry per card, in print order. */
  cards:    PrintVariableSources[]
  assets?:  PrintAssetMap
  layout:   SheetLayout
  /** Absolute epoch ms; rendering stops with SheetBudgetError once passed. */
  deadline?: number
}

export async function renderSheetsToPdf(input: SheetRenderInput): Promise<{ bytes: Uint8Array; sheets: number }> {
  const { doc, page } = prepare(input.document)
  const L = input.layout
  // The layout must have been computed for THIS card size (it never scales a card).
  if (Math.abs(L.cardW - page.width) > 0.5 || Math.abs(L.cardH - page.height) > 0.5) {
    throw new RenderError('Sheet layout does not match the card size.')
  }
  if (L.perSheet < 1) throw new RenderError('Sheet layout holds no cards.')

  const pdf   = await PDFDocument.create()
  const fonts = await buildFontSet(pdf)
  const measure = await createMeasurer()
  const imageCache = new Map<Uint8Array, PDFImage | null>()
  let sheet = null as ReturnType<typeof pdf.addPage> | null
  let sheets = 0

  for (let i = 0; i < input.cards.length; i++) {
    if (input.deadline && Date.now() > input.deadline) throw new SheetBudgetError('TIME_BUDGET')
    const k = i % L.perSheet
    if (k === 0) {
      sheet = pdf.addPage([L.pageW, L.pageH])
      sheets++
      for (const m of L.cropMarks) {
        sheet.drawLine({ start: { x: m.x1, y: L.pageH - m.y1 }, end: { x: m.x2, y: L.pageH - m.y2 }, thickness: 0.25, color: rgb(0, 0, 0) })
      }
    }
    const slot = L.slots[k]
    // Card-space (top-left origin, card height H) → sheet: translate the PDF origin to the
    // slot's bottom-left corner, then clip to the card.
    sheet!.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, 0, 1, slot.x, L.pageH - slot.y - L.cardH),
      rectangle(0, 0, L.cardW, L.cardH), clip(), endPath(),
    )
    const target = new PdfTarget(pdf, sheet!, fonts, page.width, page.height, imageCache)
    await paint(target, doc, page, measure, buildVariableMap(input.cards[i]), input.assets)
    sheet!.pushOperators(popGraphicsState())
  }

  return { bytes: await pdf.save(), sheets }
}

// ─── Text overflow (RD-PRINT-P3) ────────────────────────────────────────────────
//
// WARNINGS ONLY — nothing here changes a font size, a box or a design. For one card's
// resolved values it reports each text element whose wrapped text would not fit its box,
// using exactly the measurement and wrapping the renderer uses:
//   • 'width'  — a single word is wider than the box (it cannot wrap; it will be cut);
//   • 'height' — the wrapped lines are taller than the box (the last lines will be cut).
// On a print sheet each card is clipped to its own edges, so overflow never reaches a
// neighbouring card — but it can be cut, which is why it is reported.

export interface TextOverflow { elementId: string; kind: 'width' | 'height' }

export type TextMeasure = Measure
export const createTextMeasurer = createMeasurer

export function analyzeTextOverflow(
  document: RenderDocument, variables: PrintVariableSources, measure: TextMeasure,
): TextOverflow[] {
  const { doc, page } = prepare(document)
  const varMap = buildVariableMap(variables)
  const out: TextOverflow[] = []
  for (const el of orderedForPaint(doc.elements)) {
    if (el.type !== 'text') continue
    const pr = el.properties
    const resolved = resolvePrintText(pr.text ?? '', varMap)
    if (!resolved) continue
    const box    = elementBox(el, page)
    const fs     = fontSizePt(el, page)
    const weight = pr.fontWeight === 'bold' ? 'bold' : 'normal'
    const spacing = (pr.letterSpacing ?? 0) * fs
    const width  = (s: string) => measure(s, fs, weight) + spacing * Math.max(0, s.length - 1)
    const lines  = wrapText(resolved, s => measure(s, fs, weight), box.w)
    const EPS = 0.5   // points — sub-pixel rounding is not an overflow
    if (lines.some(l => width(l) > box.w + EPS)) { out.push({ elementId: el.id, kind: 'width' }); continue }
    // Last baseline + descender (≈ 0.2 em) must stay inside the box.
    const bottom = fs + (lines.length - 1) * fs * (pr.lineHeight ?? 1.2) + 0.2 * fs
    if (bottom > box.h + EPS) out.push({ elementId: el.id, kind: 'height' })
  }
  return out
}

/** Render to an SVG preview string (same pipeline → visually matches the PDF). */
export async function renderToSvg(input: RenderInput): Promise<string> {
  const { doc, page } = prepare(input.document)
  const measure = await createMeasurer()
  const target  = new SvgTarget(page.width, page.height)
  await paint(target, doc, page, measure, buildVariableMap(input.variables), input.assets)
  return target.toSvg()
}
