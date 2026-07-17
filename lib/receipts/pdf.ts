// Receipt PDF generator — server-only.
// Produces an A4 portrait (595 × 842 pt) payment receipt using pdf-lib.
// No canvas module required.
//
// FUTURE GST EXTENSION:
//   Populate the optional fields on ReceiptData (invoiceNumber, gstNumber,
//   gstRate, taxableAmount) and the renderGstSection() helper will automatically
//   draw an itemised tax breakdown table above the footer.  Zero redesign needed.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

// ─── Data shape ───────────────────────────────────────────────────────────────

export interface ReceiptData {
  // Core fields — always required
  registrationId:  string
  ticketCode:      string
  attendeeName:    string
  attendeeEmail:   string
  passName:        string
  eventName:       string
  organizerName:   string
  amountPaid:      number    // paise; must be > 0
  paymentId:       string    // Razorpay payment ID
  transactionDate: string    // pre-formatted, e.g. "15 Jun 2026, 14:30"

  // Optional future fields — not rendered when absent
  invoiceNumber?:  string    // sequential invoice number once implemented
  gstNumber?:      string    // organizer GSTIN, e.g. "27AADCB2230M1ZT"
  gstRate?:        number    // e.g. 18 (for 18%)
  taxableAmount?:  number    // paise — amount before tax (for breakdown)
}

// ─── Page constants ───────────────────────────────────────────────────────────

const W = 595   // A4 portrait width (pts)
const H = 842   // A4 portrait height (pts)
const M = 44    // horizontal margin

// ─── Colours ─────────────────────────────────────────────────────────────────

const C_PRIMARY  = rgb(229 / 255,  39 / 255, 126 / 255)   // #e5277e
const C_WHITE    = rgb(1, 1, 1)
const C_BLACK    = rgb(0, 0, 0)
const C_DARK     = rgb(0.08, 0.08, 0.10)
const C_GREY     = rgb(0.45, 0.45, 0.47)
const C_LTGREY   = rgb(0.92, 0.92, 0.94)
const C_EMERALD  = rgb(4 / 255, 120 / 255, 87 / 255)
const C_EMERALD_BG = rgb(0.94, 0.99, 0.97)

// ─── WinAnsi sanitiser (same as ticket PDF) ───────────────────────────────────

function s(str: string): string {
  return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').slice(0, 120)
}

// ─── INR formatter ────────────────────────────────────────────────────────────

function fmtINR(paise: number): string {
  const rupees = paise / 100
  return `INR ${rupees.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

// ─── Generator ───────────────────────────────────────────────────────────────

export async function generateReceiptPdf(data: ReceiptData): Promise<Uint8Array> {
  const doc   = await PDFDocument.create()
  const fontR = await doc.embedFont(StandardFonts.Helvetica)
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold)
  const page  = doc.addPage([W, H])

  // ── Header band ─────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 90, width: W, height: 90, color: C_PRIMARY })

  page.drawText('REGISTERDESK', {
    x: M, y: H - 24,
    size: 8, font: fontR, color: C_WHITE, opacity: 0.75,
  })

  page.drawText('PAYMENT RECEIPT', {
    x: M, y: H - 50,
    size: 20, font: fontB, color: C_WHITE,
  })

  // Receipt # right-aligned in header
  const recLabel = data.invoiceNumber
    ? `Receipt #${s(data.invoiceNumber)}`
    : `Ref: ${s(data.registrationId).slice(-12)}`
  const rlW = fontR.widthOfTextAtSize(recLabel, 9)
  page.drawText(recLabel, {
    x: W - M - rlW, y: H - 24,
    size: 9, font: fontR, color: C_WHITE, opacity: 0.8,
  })

  // Status badge (PAID) top-right
  const statusW = 52
  page.drawRectangle({
    x: W - M - statusW, y: H - 72,
    width: statusW, height: 22,
    color: C_WHITE, opacity: 0.2,
    borderColor: C_WHITE, borderWidth: 0.5, borderOpacity: 0.5,
  })
  const paidW = fontB.widthOfTextAtSize('PAID', 11)
  page.drawText('PAID', {
    x: W - M - statusW + (statusW - paidW) / 2, y: H - 65,
    size: 11, font: fontB, color: C_WHITE,
  })

  // ── Section: Billed To + Receipt Details (two columns) ──────────────────────
  const colL = M
  const colR = W / 2 + 10
  let yL     = H - 120
  let yR     = H - 120

  // Left column header
  page.drawText('BILLED TO', {
    x: colL, y: yL,
    size: 7.5, font: fontB, color: C_PRIMARY, opacity: 0.9,
  })
  yL -= 16
  page.drawText(s(data.attendeeName), {
    x: colL, y: yL,
    size: 13, font: fontB, color: C_DARK, maxWidth: W / 2 - 20,
  })
  yL -= 16
  page.drawText(s(data.attendeeEmail), {
    x: colL, y: yL,
    size: 9.5, font: fontR, color: C_GREY, maxWidth: W / 2 - 20,
  })

  // Right column header
  page.drawText('RECEIPT DETAILS', {
    x: colR, y: yR,
    size: 7.5, font: fontB, color: C_PRIMARY, opacity: 0.9,
  })
  yR -= 16

  function drawMeta(label: string, value: string, x: number, y: number): number {
    page.drawText(label.toUpperCase(), {
      x, y: y + 10,
      size: 7, font: fontR, color: C_GREY,
    })
    page.drawText(s(value), {
      x, y,
      size: 10, font: fontB, color: C_DARK, maxWidth: W / 2 - 20,
    })
    return y - 28
  }

  yR = drawMeta('Transaction Date', data.transactionDate, colR, yR)
  yR = drawMeta('Registration ID',  data.registrationId,  colR, yR)

  // ── Horizontal rule ──────────────────────────────────────────────────────────
  const sepY = Math.min(yL, yR) - 16
  page.drawLine({
    start: { x: M, y: sepY }, end: { x: W - M, y: sepY },
    thickness: 0.5, color: C_LTGREY,
  })

  // ── Event section ────────────────────────────────────────────────────────────
  let y = sepY - 28

  page.drawText('EVENT', {
    x: M, y: y + 10,
    size: 7.5, font: fontB, color: C_PRIMARY, opacity: 0.9,
  })
  y -= 4
  page.drawText(s(data.eventName).slice(0, 60), {
    x: M, y,
    size: 14, font: fontB, color: C_DARK, maxWidth: W - 2 * M,
  })
  y -= 18
  page.drawText(s(data.passName), {
    x: M, y,
    size: 10, font: fontR, color: C_GREY,
  })
  y -= 28

  // ── Separator ────────────────────────────────────────────────────────────────
  page.drawLine({
    start: { x: M, y }, end: { x: W - M, y },
    thickness: 0.5, color: C_LTGREY,
  })
  y -= 28

  // ── Amount paid (large) ──────────────────────────────────────────────────────
  // Emerald badge
  const amtStr  = fmtINR(data.amountPaid)
  const badgeW  = W - 2 * M
  const badgeH  = 64
  page.drawRectangle({
    x: M, y: y - badgeH,
    width: badgeW, height: badgeH,
    color: C_EMERALD_BG,
    borderColor: C_EMERALD,
    borderWidth: 0.75,
  })
  page.drawText('AMOUNT PAID', {
    x: M + 16, y: y - 18,
    size: 8, font: fontR, color: C_EMERALD,
  })
  page.drawText(amtStr, {
    x: M + 16, y: y - 42,
    size: 22, font: fontB, color: C_EMERALD,
  })
  // Bullet status right-aligned inside badge
  const stW = fontB.widthOfTextAtSize('●  Paid', 11)
  page.drawText('●  Paid', {
    x: M + badgeW - stW - 16, y: y - 36,
    size: 11, font: fontB, color: C_EMERALD,
  })
  y -= badgeH + 24

  // ── Payment details table ────────────────────────────────────────────────────
  page.drawText('PAYMENT DETAILS', {
    x: M, y: y + 10,
    size: 7.5, font: fontB, color: C_PRIMARY, opacity: 0.9,
  })
  y -= 10

  function drawRow(label: string, value: string): void {
    page.drawText(s(label), {
      x: M, y,
      size: 9.5, font: fontR, color: C_GREY,
    })
    page.drawText(s(value), {
      x: M + 160, y,
      size: 9.5, font: fontB, color: C_DARK, maxWidth: W - M - 160 - M,
    })
    y -= 20
  }

  page.drawLine({
    start: { x: M, y: y + 14 }, end: { x: W - M, y: y + 14 },
    thickness: 0.4, color: C_LTGREY,
  })
  y -= 6

  drawRow('Ticket Code',   data.ticketCode)
  drawRow('Payment ID',    data.paymentId)
  drawRow('Amount',        fmtINR(data.amountPaid))
  drawRow('Transaction',   data.transactionDate)

  page.drawLine({
    start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 },
    thickness: 0.4, color: C_LTGREY,
  })
  y -= 24

  // ── Organizer ────────────────────────────────────────────────────────────────
  page.drawText('ISSUED BY', {
    x: M, y: y + 10,
    size: 7.5, font: fontB, color: C_PRIMARY, opacity: 0.9,
  })
  y -= 6
  page.drawText(s(data.organizerName), {
    x: M, y,
    size: 11, font: fontB, color: C_DARK,
  })
  y -= 24

  // ── GST placeholder (rendered only when fields are present) ──────────────────
  if (data.gstNumber || data.invoiceNumber) {
    page.drawLine({
      start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 },
      thickness: 0.4, color: C_LTGREY,
    })
    y -= 10
    page.drawText('TAX DETAILS', {
      x: M, y: y + 10,
      size: 7.5, font: fontB, color: C_PRIMARY, opacity: 0.9,
    })
    y -= 10
    if (data.invoiceNumber) drawRow('Invoice Number', data.invoiceNumber)
    if (data.gstNumber)     drawRow('GSTIN',          data.gstNumber)
    if (data.gstRate != null && data.taxableAmount != null) {
      const taxAmt = Math.round(data.taxableAmount * data.gstRate / 100)
      drawRow(`GST (${data.gstRate}%)`, fmtINR(taxAmt))
      drawRow('Taxable Amount', fmtINR(data.taxableAmount))
    }
  }

  // ── Footer ───────────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: 36, color: C_LTGREY })
  page.drawText('Powered by RegisterDesk · registerdesk.in', {
    x: M, y: 13,
    size: 8, font: fontR, color: C_GREY,
  })
  page.drawText('This is a system-generated receipt and does not require a signature.', {
    x: M, y: 24,
    size: 7.5, font: fontR, color: C_GREY,
  })

  return doc.save()
}
