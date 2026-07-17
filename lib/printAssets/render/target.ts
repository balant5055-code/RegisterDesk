// PA-3 — Draw backends. A single DrawTarget interface is driven by ONE element
// loop in renderer.ts; the PDF backend (pdf-lib) and the SVG backend emit from
// the exact same geometry so the preview visually matches the PDF.
//
// Coordinate contract for every method: POINTS, TOP-LEFT origin, y-down. The PDF
// backend flips internally to pdf-lib's bottom-left, y-up space. Rotation is
// clockwise degrees about the ELEMENT box center (placeholder sub-shapes rotate
// about the element center too, so parts stay rigid).

import { degrees, rgb, PDFDocument, type PDFPage, type PDFImage } from 'pdf-lib'
import type { FontSet } from '@/lib/certificates/fonts'
import { sanitizeWinAnsi } from '@/lib/certificates/fonts'
import type { FontFamily } from '@/lib/certificates/types'
import { qrModules } from '@/lib/qr/draw'
import { barcodeModules, darkRuns, type BarcodeFormat } from './barcode'
import { hexRgb01, normalizeHex, rotateAbout, type PositionedLine } from './geometry'
import type { Box } from './types'

export interface RectStyle {
  fill?:          string
  stroke?:        string
  strokeWidthPt?: number
  radiusPt?:      number
  opacity:        number
}
export interface TextStyle {
  fontSizePt:      number
  fontFamily:      FontFamily
  weight:          'normal' | 'bold'
  color:           string
  opacity:         number
  letterSpacingPt: number
}

// Map the internal font family to a CSS font stack for the SVG preview.
const SVG_FONT_STACK: Record<FontFamily, string> = {
  helvetica: 'Helvetica, Arial, sans-serif',
  times:     "'Times New Roman', Times, serif",
  courier:   "'Courier New', Courier, monospace",
}

export interface ImageDraw {
  bytes:       Uint8Array
  contentType: string   // 'image/png' | 'image/jpeg'
  fit:         string   // 'contain' | 'cover'
  opacity:     number
}
export interface QrDraw {
  value:   string
  dark:    string   // hex module color
  opacity: number
}
export interface BarcodeDraw {
  value:   string
  format:  BarcodeFormat
  dark:    string   // hex bar color
  opacity: number
}

export interface DrawTarget {
  fillBackground(color: string): void
  canvasBorder(color: string, widthPt: number): void
  rect(box: Box, style: RectStyle): void
  image(box: Box, o: ImageDraw): void | Promise<void>
  qr(box: Box, o: QrDraw): void
  barcode(box: Box, o: BarcodeDraw): void
  text(box: Box, lines: PositionedLine[], style: TextStyle): void | Promise<void>
}

const isJpeg = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff

// ─── PDF backend ────────────────────────────────────────────────────────────────

export class PdfTarget implements DrawTarget {
  constructor(
    private readonly doc: PDFDocument,
    private readonly page: PDFPage,
    private readonly fonts: FontSet,
    private readonly W: number,
    private readonly H: number,
  ) {}

  fillBackground(color: string): void {
    const { r, g, b } = hexRgb01(color)
    this.page.drawRectangle({ x: 0, y: 0, width: this.W, height: this.H, color: rgb(r, g, b) })
  }

  canvasBorder(color: string, widthPt: number): void {
    if (widthPt <= 0) return
    const inset = widthPt / 2
    const { r, g, b } = hexRgb01(color)
    this.page.drawRectangle({
      x: inset, y: inset, width: this.W - widthPt, height: this.H - widthPt,
      borderColor: rgb(r, g, b), borderWidth: widthPt,
    })
  }

  /** Draw a rect (top-left space) rotating about `pivot` (defaults to own center). */
  private drawRectTL(tlx: number, tly: number, w: number, h: number, deg: number, style: RectStyle, pivot?: { cx: number; cy: number }): void {
    const pcx = pivot ? pivot.cx : tlx + w / 2
    const pcy = pivot ? pivot.cy : tly + h / 2
    const blx = tlx, bly = this.H - (tly + h)          // bottom-left in pdf space
    const anchor = deg
      ? rotateAbout(blx, bly, pcx, this.H - pcy, -deg * Math.PI / 180)
      : { x: blx, y: bly }
    const fill   = style.fill   ? hexRgb01(style.fill)   : null
    const stroke = style.stroke && style.strokeWidthPt ? hexRgb01(style.stroke) : null
    this.page.drawRectangle({
      x: anchor.x, y: anchor.y, width: w, height: h, rotate: degrees(-deg),
      color:        fill   ? rgb(fill.r, fill.g, fill.b) : undefined,
      opacity:      fill   ? style.opacity : undefined,
      borderColor:  stroke ? rgb(stroke.r, stroke.g, stroke.b) : undefined,
      borderWidth:  stroke ? style.strokeWidthPt : undefined,
      borderOpacity: stroke ? style.opacity : undefined,
    })
  }

  rect(box: Box, style: RectStyle): void {
    this.drawRectTL(box.x, box.y, box.w, box.h, box.rotation, style)
  }

  async image(box: Box, o: ImageDraw): Promise<void> {
    let img: PDFImage
    try {
      img = isJpeg(o.bytes) || o.contentType === 'image/jpeg'
        ? await this.doc.embedJpg(o.bytes)
        : await this.doc.embedPng(o.bytes)
    } catch { return }   // undecodable asset — skip (matches certificate renderer)

    // Fit the image inside the box, then rotate the placement about the box center.
    const ar = img.width / img.height
    let dw = box.w, dh = box.h
    if (o.fit === 'cover') { if (box.w / box.h > ar) dh = box.w / ar; else dw = box.h * ar }
    else                   { if (box.w / box.h > ar) dw = box.h * ar; else dh = box.w / ar }
    const dxTL = box.x + (box.w - dw) / 2
    const dyTL = box.y + (box.h - dh) / 2
    const deg  = box.rotation || 0
    const blx = dxTL, bly = this.H - (dyTL + dh)
    const anchor = deg
      ? rotateAbout(blx, bly, box.x + box.w / 2, this.H - (box.y + box.h / 2), -deg * Math.PI / 180)
      : { x: blx, y: bly }
    this.page.drawImage(img, { x: anchor.x, y: anchor.y, width: dw, height: dh, rotate: degrees(-deg), opacity: o.opacity })
  }

  qr(box: Box, o: QrDraw): void {
    const pivot = { cx: box.x + box.w / 2, cy: box.y + box.h / 2 }
    const s  = Math.min(box.w, box.h)
    const ox = box.x + (box.w - s) / 2, oy = box.y + (box.h - s) / 2
    // Quiet zone: white square behind the code.
    this.drawRectTL(ox, oy, s, s, box.rotation, { fill: '#ffffff', opacity: o.opacity }, pivot)
    const { dim, isDark } = qrModules(o.value)
    const cell = s / dim
    for (let row = 0; row < dim; row++) {
      for (let col = 0; col < dim; col++) {
        if (isDark(row, col)) {
          this.drawRectTL(ox + col * cell, oy + row * cell, cell, cell, box.rotation, { fill: o.dark, opacity: o.opacity }, pivot)
        }
      }
    }
  }

  barcode(box: Box, o: BarcodeDraw): void {
    const mods = barcodeModules(o.value, o.format)
    if (mods.length === 0) return
    const pivot = { cx: box.x + box.w / 2, cy: box.y + box.h / 2 }
    // Quiet zone behind the bars, then dark bars spanning the full box height.
    this.drawRectTL(box.x, box.y, box.w, box.h, box.rotation, { fill: '#ffffff', opacity: o.opacity }, pivot)
    const unit = box.w / mods.length
    for (const [start, width] of darkRuns(mods)) {
      this.drawRectTL(box.x + start * unit, box.y, width * unit, box.h, box.rotation, { fill: o.dark, opacity: o.opacity }, pivot)
    }
  }

  async text(box: Box, lines: PositionedLine[], style: TextStyle): Promise<void> {
    const { r, g, b } = hexRgb01(style.color)
    const color = rgb(r, g, b)
    const pcx = box.x + box.w / 2, pcy = box.y + box.h / 2
    const deg = box.rotation || 0
    const place = (x: number, yTop: number) => {
      if (!deg) return { x, y: this.H - yTop, rot: 0 }
      const p = rotateAbout(x, this.H - yTop, pcx, this.H - pcy, -deg * Math.PI / 180)
      return { x: p.x, y: p.y, rot: -deg }
    }
    for (const ln of lines) {
      if (!ln.text) continue
      const picked = await this.fonts.pick(style.fontFamily, { bold: style.weight === 'bold' }, ln.text)
      const text = picked.isUnicode ? ln.text : sanitizeWinAnsi(ln.text)
      if (!text) continue
      const font = picked.font
      if (style.letterSpacingPt !== 0) {
        let cx = ln.x
        for (const ch of text) {
          const pos = place(cx, ln.baselineY)
          this.page.drawText(ch, { x: pos.x, y: pos.y, size: style.fontSizePt, font, color, opacity: style.opacity, rotate: degrees(pos.rot) })
          cx += font.widthOfTextAtSize(ch, style.fontSizePt) + style.letterSpacingPt
        }
      } else {
        const pos = place(ln.x, ln.baselineY)
        this.page.drawText(text, { x: pos.x, y: pos.y, size: style.fontSizePt, font, color, opacity: style.opacity, rotate: degrees(pos.rot) })
      }
    }
  }
}

// ─── SVG backend ────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export class SvgTarget implements DrawTarget {
  private parts: string[] = []
  constructor(private readonly W: number, private readonly H: number) {}

  private rot(deg: number, cx: number, cy: number): string {
    return deg ? ` transform="rotate(${deg} ${cx.toFixed(2)} ${cy.toFixed(2)})"` : ''
  }

  fillBackground(color: string): void {
    this.parts.push(`<rect x="0" y="0" width="${this.W}" height="${this.H}" fill="${normalizeHex(color)}"/>`)
  }

  canvasBorder(color: string, widthPt: number): void {
    if (widthPt <= 0) return
    const i = widthPt / 2
    this.parts.push(`<rect x="${i}" y="${i}" width="${this.W - widthPt}" height="${this.H - widthPt}" fill="none" stroke="${normalizeHex(color)}" stroke-width="${widthPt}"/>`)
  }

  private rectStr(x: number, y: number, w: number, h: number, style: RectStyle): string {
    const fill = style.fill ? normalizeHex(style.fill) : 'none'
    const stroke = style.stroke && style.strokeWidthPt ? ` stroke="${normalizeHex(style.stroke)}" stroke-width="${style.strokeWidthPt}"` : ''
    const rx = style.radiusPt ? ` rx="${style.radiusPt.toFixed(2)}"` : ''
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}"${stroke}${rx} opacity="${style.opacity}"/>`
  }

  rect(box: Box, style: RectStyle): void {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    this.parts.push(`<g${this.rot(box.rotation, cx, cy)}>${this.rectStr(box.x, box.y, box.w, box.h, style)}</g>`)
  }

  image(box: Box, o: ImageDraw): void {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    const mime = isJpeg(o.bytes) ? 'image/jpeg' : (o.contentType || 'image/png')
    const b64  = Buffer.from(o.bytes).toString('base64')
    // SVG handles the fit natively: contain → meet, cover → slice.
    const par  = o.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'
    const href = `data:${mime};base64,${b64}`
    this.parts.push(
      `<g${this.rot(box.rotation, cx, cy)} opacity="${o.opacity}">` +
      `<image x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.w.toFixed(2)}" height="${box.h.toFixed(2)}" preserveAspectRatio="${par}" href="${href}"/></g>`,
    )
  }

  qr(box: Box, o: QrDraw): void {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    const s  = Math.min(box.w, box.h)
    const ox = box.x + (box.w - s) / 2, oy = box.y + (box.h - s) / 2
    const { dim, isDark } = qrModules(o.value)
    const cell = s / dim
    const dark = normalizeHex(o.dark)
    const cells: string[] = [`<rect x="${ox.toFixed(2)}" y="${oy.toFixed(2)}" width="${s.toFixed(2)}" height="${s.toFixed(2)}" fill="#ffffff"/>`]
    for (let row = 0; row < dim; row++) {
      for (let col = 0; col < dim; col++) {
        if (isDark(row, col)) {
          cells.push(`<rect x="${(ox + col * cell).toFixed(3)}" y="${(oy + row * cell).toFixed(3)}" width="${cell.toFixed(3)}" height="${cell.toFixed(3)}" fill="${dark}"/>`)
        }
      }
    }
    this.parts.push(`<g${this.rot(box.rotation, cx, cy)} opacity="${o.opacity}">${cells.join('')}</g>`)
  }

  barcode(box: Box, o: BarcodeDraw): void {
    const mods = barcodeModules(o.value, o.format)
    if (mods.length === 0) return
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    const unit = box.w / mods.length
    const dark = normalizeHex(o.dark)
    const parts: string[] = [`<rect x="${box.x.toFixed(2)}" y="${box.y.toFixed(2)}" width="${box.w.toFixed(2)}" height="${box.h.toFixed(2)}" fill="#ffffff"/>`]
    for (const [start, width] of darkRuns(mods)) {
      parts.push(`<rect x="${(box.x + start * unit).toFixed(3)}" y="${box.y.toFixed(2)}" width="${(width * unit).toFixed(3)}" height="${box.h.toFixed(2)}" fill="${dark}"/>`)
    }
    this.parts.push(`<g${this.rot(box.rotation, cx, cy)} opacity="${o.opacity}">${parts.join('')}</g>`)
  }

  text(box: Box, lines: PositionedLine[], style: TextStyle): void {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    const weight = style.weight === 'bold' ? '700' : '400'
    const spacing = style.letterSpacingPt ? ` letter-spacing="${style.letterSpacingPt.toFixed(2)}"` : ''
    const fontFamily = SVG_FONT_STACK[style.fontFamily] ?? SVG_FONT_STACK.helvetica
    const body = lines.filter(l => l.text).map(l =>
      `<text x="${l.x.toFixed(2)}" y="${l.baselineY.toFixed(2)}" font-family="${fontFamily}" font-size="${style.fontSizePt.toFixed(2)}" font-weight="${weight}" fill="${normalizeHex(style.color)}"${spacing}>${esc(l.text)}</text>`,
    ).join('')
    this.parts.push(`<g${this.rot(box.rotation, cx, cy)} opacity="${style.opacity}">${body}</g>`)
  }

  /** Serialize to a standalone SVG document. */
  toSvg(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.W}" height="${this.H}" viewBox="0 0 ${this.W} ${this.H}">${this.parts.join('')}</svg>`
  }
}

/** Build a measurement function from pdf-lib Helvetica metrics (shared wrapping). */
export async function createMeasurer(): Promise<(s: string, sizePt: number, weight: 'normal' | 'bold') => number> {
  const doc = await PDFDocument.create()
  const { StandardFonts } = await import('pdf-lib')
  const reg  = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  return (s, sizePt, weight) => (weight === 'bold' ? bold : reg).widthOfTextAtSize(sanitizeWinAnsi(s) || s, sizePt)
}
