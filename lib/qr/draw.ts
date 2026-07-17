// Shared QR drawing helper (PA-5). Server-safe.
//
// ONE place that turns a payload string into QR modules and paints them as filled
// squares — replacing the byte-identical `drawQr` copies previously duplicated in
// the certificate renderer, the legacy certificate PDF, and the ticket PDF. Every
// PDF QR now flows through here; the print renderer reuses `qrModules` for its
// rotation-aware / SVG backends. No canvas/native module — pdf-lib rectangles only.

import QRCode from 'qrcode'
import { rgb, type PDFPage, type RGB } from 'pdf-lib'

export type QrEcc = 'L' | 'M' | 'Q' | 'H'

export interface QrModules {
  dim: number
  isDark(row: number, col: number): boolean
}

/** The QR module matrix for a value — the single QR generation seam. */
export function qrModules(value: string, ecc: QrEcc = 'M'): QrModules {
  const qr = QRCode.create(value, { errorCorrectionLevel: ecc })
  const m  = qr.modules
  return { dim: m.size, isDark: (row, col) => !!m.get(row, col) }
}

/**
 * Paints a QR onto a pdf-lib page as filled square modules, bottom-left origin
 * (pdf y-up). `(x, y)` is the QR's bottom-left corner; `size` is its side length.
 */
export function drawQrToPdf(
  page: PDFPage,
  value: string,
  opts: { x: number; y: number; size: number; color?: RGB; ecc?: QrEcc },
): void {
  const { dim, isDark } = qrModules(value, opts.ecc ?? 'M')
  const cell  = opts.size / dim
  const color = opts.color ?? rgb(0, 0, 0)
  for (let row = 0; row < dim; row++) {
    for (let col = 0; col < dim; col++) {
      if (isDark(row, col)) {
        page.drawRectangle({
          x:      opts.x + col * cell,
          y:      opts.y + (dim - row - 1) * cell,
          width:  cell,
          height: cell,
          color,
        })
      }
    }
  }
}
