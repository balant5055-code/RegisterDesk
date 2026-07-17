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

import { PDFDocument } from 'pdf-lib'
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

/** Render to an SVG preview string (same pipeline → visually matches the PDF). */
export async function renderToSvg(input: RenderInput): Promise<string> {
  const { doc, page } = prepare(input.document)
  const measure = await createMeasurer()
  const target  = new SvgTarget(page.width, page.height)
  await paint(target, doc, page, measure, buildVariableMap(input.variables), input.assets)
  return target.toSvg()
}
