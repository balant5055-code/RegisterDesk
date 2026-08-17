// Certificate overlay renderer — server-only.
// Renders a PDF certificate by drawing the layout (Phase 10 builder design) onto the
// organizer's active template (PDF / PNG / JPG). ONLY the elements in that layout are
// drawn — see the note in renderCertificatePdf on why there is no default design.
//
// Layouts are resolution-independent: element positions/sizes are FRACTIONS
// [0,1] of the reference canvas with a TOP-LEFT origin; this renderer maps them
// onto the actual output and flips to pdf-lib's bottom-left origin. Text honors
// embedded Unicode fonts (non-Latin names) via the font registry. Image assets
// are passed in pre-fetched (one fetch per bulk chunk, not per certificate).

import { PDFDocument, rgb, degrees } from 'pdf-lib'
import { drawQrToPdf }      from '@/lib/qr/draw'
import { replaceVariables } from './placeholders'
import { buildFontSet, sanitizeWinAnsi } from './fonts'
import type { FontSet } from './fonts'
import type { PlaceholderContext } from './placeholders'
import type {
  TemplateType,
  CertificateDimensions,
  CertificateLayout,
  TextLayoutElement,
  ImageLayoutElement,
  QrLayoutElement,
  LineLayoutElement,
} from './types'

type AnyPage = ReturnType<PDFDocument['addPage']>

const MAX_OUTPUT_EDGE = 1600   // cap image-template page size (pt)
const DEFAULT_W = 842          // A4 landscape fallback
const DEFAULT_H = 595

// ─── Small helpers ──────────────────────────────────────────────────────────

function hexToRgb(hex: string) {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return rgb(r || 0, g || 0, b || 0)
}

function isJpeg(b: Uint8Array): boolean {
  return b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
}

// Rotation transform (GA-4 S2) — mirrors the print engine's rotate-about-center
// logic (lib/printAssets/render/target.ts + geometry.rotateAbout). Layout rotation
// is CLOCKWISE degrees in top-left space; pdf-lib space is bottom-left/y-up, so a
// draw anchor is pre-rotated about the box centre and drawn with rotate(-deg).
function rotatePoint(x: number, y: number, cx: number, cy: number, rad: number): { x: number; y: number } {
  const s = Math.sin(rad), c = Math.cos(rad), dx = x - cx, dy = y - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

interface RotAnchor { x: number; y: number; rotate: ReturnType<typeof degrees> }

// `ax,ay` = the primitive's bottom-left anchor in PDF space; box is in TOP-LEFT
// pixel space. Returns the rotated anchor + pdf-lib rotate value (no-op when deg=0).
function rotAnchor(ax: number, ay: number, leftPx: number, topPx: number, boxWpx: number, boxHpx: number, H: number, deg: number): RotAnchor {
  if (!deg) return { x: ax, y: ay, rotate: degrees(0) }
  const pcx    = leftPx + boxWpx / 2
  const pcyPdf = H - (topPx + boxHpx / 2)
  const p = rotatePoint(ax, ay, pcx, pcyPdf, -deg * Math.PI / 180)
  return { x: p.x, y: p.y, rotate: degrees(-deg) }
}

// Draw a QR code as filled rectangles — no canvas dependency (shared helper).
function drawQr(page: AnyPage, value: string, x: number, y: number, size: number, darkHex?: string): void {
  drawQrToPdf(page, value, { x, y, size, color: darkHex ? hexToRgb(darkHex) : rgb(0.1, 0.1, 0.1) })
}

// Greedy word-wrap to a max width (px). Latin-friendly; CJK without spaces is
// left as a single line (acceptable for v1 — the box still clips visually).
function wrapText(
  text: string,
  measure: (s: string) => number,
  maxWidth: number,
): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    if (words.length === 0) { out.push(''); continue }
    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`
      if (measure(candidate) <= maxWidth) line = candidate
      else { out.push(line); line = words[i] }
    }
    out.push(line)
  }
  return out
}

// ─── Element renderers ────────────────────────────────────────────────────────

async function drawTextEl(
  page: AnyPage, fonts: FontSet, el: TextLayoutElement,
  W: number, H: number, context: PlaceholderContext,
): Promise<void> {
  const resolved = replaceVariables(el.content, context)
  if (!resolved) return

  const fontSize = Math.max(1, el.fontSizeFrac * H)
  const { font, isUnicode } = await fonts.pick(
    el.fontFamily, { bold: el.weight === 'bold', italic: el.italic }, resolved,
  )
  const text = isUnicode ? resolved : sanitizeWinAnsi(resolved)
  if (!text) return

  const color   = hexToRgb(el.color)
  const opacity = el.opacity ?? 1
  const left    = el.x * W
  const topPx   = el.y * H
  const boxW    = el.width ? el.width * W : null
  const lineHeight = fontSize * 1.25
  const measure = (s: string) => font.widthOfTextAtSize(s, fontSize)

  const lines = boxW ? wrapText(text, measure, boxW) : text.split('\n')
  let baseline = H - topPx - fontSize   // top-anchored first line

  // Rotation pivot = the text block's box centre (GA-4 S2).
  const deg     = el.rotation ?? 0
  const totalH  = lines.length * lineHeight
  const pivotW  = boxW ?? Math.max(1, ...lines.map(measure))
  for (const line of lines) {
    const lineW = measure(line)
    let x = left
    if (boxW) {
      if (el.align === 'center') x = left + (boxW - lineW) / 2
      else if (el.align === 'right') x = left + boxW - lineW
    } else {
      if (el.align === 'center') x = left - lineW / 2
      else if (el.align === 'right') x = left - lineW
    }
    const a = rotAnchor(x, baseline, left, topPx, pivotW, totalH, H, deg)
    page.drawText(line, { x: a.x, y: a.y, size: fontSize, font, color, opacity, rotate: a.rotate })
    baseline -= lineHeight
  }
}

async function drawImageEl(
  page: AnyPage, doc: PDFDocument, el: ImageLayoutElement,
  W: number, H: number, assets: Map<string, Uint8Array> | undefined,
  attendeePhoto: Uint8Array | undefined,
): Promise<void> {
  // RD-CERT-PHOTO-01 — the attendee photo is passed in SEPARATELY, never through the
  // `assets` map. That map is the template-level, cross-certificate cache; putting a
  // per-registration photo into it is exactly how one attendee's face would end up on
  // another attendee's certificate.
  //
  // An attendeePhoto element NEVER falls back to `assetUrl`: its assetUrl is empty by
  // construction, and reading the map here would let a stale URL paint someone else's
  // asset into the photo box.
  const bytes = el.source === 'attendeePhoto' ? attendeePhoto : assets?.get(el.assetUrl)
  // No photo (or asset not pre-fetched / blocked) — skip the element rather than fail.
  // This is the whole no-photo story: the box simply does not draw.
  if (!bytes) return
  let img
  try {
    img = isJpeg(bytes) ? await doc.embedJpg(bytes) : await doc.embedPng(bytes)
  } catch {
    return
  }

  const boxLeft = el.x * W
  const boxTop  = el.y * H
  const boxW    = (el.width  ?? 0.2) * W
  const boxH    = (el.height ?? 0.2) * H
  const ar      = img.width / img.height

  let dw = boxW
  let dh = boxH
  if (el.fit === 'contain') {
    if (boxW / boxH > ar) dw = boxH * ar
    else dh = boxW / ar
  } else { // cover
    if (boxW / boxH > ar) dh = boxW / ar
    else dw = boxH * ar
  }

  const dx     = boxLeft + (boxW - dw) / 2
  const dyTop  = boxTop  + (boxH - dh) / 2
  const a = rotAnchor(dx, H - dyTop - dh, boxLeft, boxTop, boxW, boxH, H, el.rotation ?? 0)
  page.drawImage(img, { x: a.x, y: a.y, width: dw, height: dh, opacity: el.opacity ?? 1, rotate: a.rotate })
}

function drawQrEl(page: AnyPage, el: QrLayoutElement, W: number, H: number, verifyUrl: string): void {
  const boxLeft = el.x * W
  const boxTop  = el.y * H
  const size    = Math.min((el.width ?? 0.15) * W, (el.height ?? 0.15) * H)
  drawQr(page, verifyUrl, boxLeft, H - boxTop - size, size, el.darkColor)
}

function drawLineEl(page: AnyPage, el: LineLayoutElement, W: number, H: number): void {
  const left      = el.x * W
  const topPx     = el.y * H
  const width     = (el.width ?? 0.2) * W
  const thickness = Math.max(0.5, el.thickness * H)
  const a = rotAnchor(left, H - topPx - thickness, left, topPx, width, thickness, H, el.rotation ?? 0)
  page.drawRectangle({
    x: a.x, y: a.y, width, height: thickness, rotate: a.rotate,
    color: hexToRgb(el.color), opacity: el.opacity ?? 1,
  })
}

// ─── Public entry point ─────────────────────────────────────────────────────

export interface RenderCertificateInput {
  templateBytes: Uint8Array
  templateType:  TemplateType
  dimensions:    CertificateDimensions | null
  context:       PlaceholderContext      // full resolved placeholders
  verifyUrl:     string
  layout?:       CertificateLayout | null
  /** Pre-fetched image asset bytes by URL (R-5). TEMPLATE-level, shared across a batch. */
  assets?:       Map<string, Uint8Array>
  /**
   * RD-CERT-PHOTO-01 — THIS certificate's attendee photo, already cropped and resized by
   * the attendee's browser and resolved to BYTES by the generation layer. Deliberately a
   * separate parameter rather than an entry in `assets`: it is per-registration and must
   * never be cached across certificates.
   *
   * Bytes only — the renderer never fetches a URL, never builds one, and never accepts a
   * key or URL from a client. Undefined ⇒ the attendee has no photo and any attendeePhoto
   * element is skipped.
   */
  attendeePhoto?: Uint8Array
}

function imageOutputSize(dim: CertificateDimensions | null): { W: number; H: number } {
  if (!dim || dim.width <= 0 || dim.height <= 0) return { W: DEFAULT_W, H: DEFAULT_H }
  const longest = Math.max(dim.width, dim.height)
  const scale   = longest > MAX_OUTPUT_EDGE ? MAX_OUTPUT_EDGE / longest : 1
  return { W: Math.round(dim.width * scale), H: Math.round(dim.height * scale) }
}

export async function renderCertificatePdf(input: RenderCertificateInput): Promise<Uint8Array> {
  const { templateBytes, templateType, dimensions, context, verifyUrl, layout, assets, attendeePhoto } = input

  let doc:  PDFDocument
  let page: AnyPage
  let W: number
  let H: number

  if (templateType === 'pdf') {
    doc = await PDFDocument.load(templateBytes, { ignoreEncryption: true })
    if (doc.getPageCount() === 0) throw new Error('Template PDF has no pages')
    page = doc.getPage(0)
    const s = page.getSize()
    W = s.width; H = s.height
  } else {
    doc = await PDFDocument.create()
    const img = templateType === 'png' ? await doc.embedPng(templateBytes) : await doc.embedJpg(templateBytes)
    ;({ W, H } = imageOutputSize(dimensions))
    page = doc.addPage([W, H])
    page.drawImage(img, { x: 0, y: 0, width: W, height: H })
  }

  const fonts = await buildFontSet(doc)

  // RD-CERT-2E — THE LAYOUT IS THE WHOLE CONTRACT. Only elements the organizer placed are
  // drawn. There is deliberately no `else`: this used to fall back to a built-in design that
  // stamped the participant's name, the certificate id and a QR onto the artwork, so a
  // template with zero elements silently produced a certificate carrying attendee data the
  // organizer never asked for — landing at fixed coordinates over their background.
  //
  // A template with no design can no longer reach this function at all: `assertTemplateIsDesigned`
  // in generate.ts refuses issuance, preview and re-render first. Rendering nothing here would
  // be a blank certificate, which is why the guard lives upstream rather than as a fallback.
  const ordered = [...(layout?.elements ?? [])].sort((a, b) => a.zIndex - b.zIndex)
  for (const el of ordered) {
    switch (el.type) {
      case 'text':  await drawTextEl(page, fonts, el, W, H, context); break
      case 'image': await drawImageEl(page, doc, el, W, H, assets, attendeePhoto); break
      case 'qr':    drawQrEl(page, el, W, H, verifyUrl);              break
      case 'line':  drawLineEl(page, el, W, H);                       break
      // Unknown types are skipped (forward-compatible).
    }
  }

  return doc.save()
}
