// Server-only: PDF receipt generator using pdf-lib with WinAnsi-safe fonts.
//
// WinAnsi constraint: pdf-lib's StandardFonts (Helvetica, HelveticaBold) only
// encode U+0020–U+007E and U+00A0–U+00FF.  This means:
//   • ₹ (U+20B9, RUPEE SIGN) cannot be used — amounts use "INR" prefix instead.
//   • All user-supplied strings (names, titles) must pass through sanitizePdf().

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'

// ─── Colours ──────────────────────────────────────────────────────────────────

const C_ORANGE    = rgb(249 / 255,  115 / 255,  22 / 255)   // orange-500 #f97316
const C_WHITE     = rgb(1, 1, 1)
const C_BLACK     = rgb(0, 0, 0)
const C_GREY      = rgb(0.42, 0.42, 0.42)
const C_LIGHTGREY = rgb(0.92, 0.92, 0.93)
const C_EMERALD   = rgb(4  / 255, 120 / 255, 87 / 255)      // #047857

// ─── WinAnsi sanitiser ────────────────────────────────────────────────────────

function sanitizePdf(str: string): string {
  return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim()
}

// ─── Formatters ───────────────────────────────────────────────────────────────

export function fmtReceiptDate(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

function fmtINR(rupees: number): string {
  try {
    return 'INR ' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees)
  } catch {
    return `INR ${rupees.toLocaleString()}`
  }
}

function fmtExpiryDate(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  })
}

// ─── Drawing helpers ──────────────────────────────────────────────────────────

function drawSectionLabel(
  page:  PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  text:  string,
  x:     number,
  y:     number,
  color  = C_GREY,
): void {
  page.drawText(text.toUpperCase(), { x, y, size: 7.5, font: fonts.regular, color })
}

function drawSeparator(page: PDFPage, x1: number, x2: number, y: number): void {
  page.drawLine({
    start:     { x: x1, y },
    end:       { x: x2, y },
    thickness: 0.5,
    color:     C_LIGHTGREY,
  })
}

/** Draw a labelled field. Returns next y (cursor moves down 32 pts). */
function drawField(
  page:       PDFPage,
  fonts:      { regular: PDFFont; bold: PDFFont },
  label:      string,
  value:      string,
  x:          number,
  y:          number,
  valueColor  = C_BLACK,
  valueSize   = 11,
): number {
  page.drawText(label.toUpperCase(), { x, y: y + 13, size: 7, font: fonts.regular, color: C_GREY })
  page.drawText(sanitizePdf(value).slice(0, 70), { x, y, size: valueSize, font: fonts.bold, color: valueColor })
  return y - 34
}

/** Like drawField but renders in two columns. */
function drawFieldPair(
  page:  PDFPage,
  fonts: { regular: PDFFont; bold: PDFFont },
  left:  { label: string; value: string },
  right: { label: string; value: string },
  xL:    number,
  xR:    number,
  y:     number,
): number {
  page.drawText(left.label.toUpperCase(),  { x: xL, y: y + 13, size: 7, font: fonts.regular, color: C_GREY })
  page.drawText(sanitizePdf(left.value).slice(0, 30),  { x: xL, y, size: 11, font: fonts.bold,    color: C_BLACK })
  page.drawText(right.label.toUpperCase(), { x: xR, y: y + 13, size: 7, font: fonts.regular, color: C_GREY })
  page.drawText(sanitizePdf(right.value).slice(0, 30), { x: xR, y, size: 11, font: fonts.bold,    color: C_BLACK })
  return y - 34
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface ReceiptPdfParams {
  receiptNumber:  string
  donorName:      string
  donorEmail:     string
  campaignTitle:  string
  organizerName:  string
  amountRupees:   number
  transactionId:  string    // razorpayPaymentId
  paidAt:         Date
  is80G:          boolean
  // 80G fields — only used when is80G === true
  organizerPan?:        string
  reg80GNumber?:        string
  reg80GCertExpiry?:    string   // YYYY-MM-DD
}

export async function generateReceiptPdf(params: ReceiptPdfParams): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create()
  const fontR  = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fonts  = { regular: fontR, bold: fontB }

  // A4 portrait
  const W = 595
  const H = 842
  const page = pdfDoc.addPage([W, H])

  const MARGIN = 44
  const xL = MARGIN          // left column x
  const xR = MARGIN + 260    // right column x

  // ── Header band ─────────────────────────────────────────────────────────────

  const HEADER_H = 88
  page.drawRectangle({ x: 0, y: H - HEADER_H, width: W, height: HEADER_H, color: C_ORANGE })

  page.drawText('REGISTERDESK', {
    x: MARGIN, y: H - 22,
    size: 9, font: fontR,
    color: C_WHITE,
    opacity: 0.85,
  })

  page.drawText('Donation Receipt', {
    x: MARGIN, y: H - 50,
    size: 22, font: fontB,
    color: C_WHITE,
  })

  // Receipt number in header (right-aligned)
  const rnLabel = sanitizePdf(params.receiptNumber)
  const rnWidth = fontB.widthOfTextAtSize(rnLabel, 10)
  page.drawText(rnLabel, {
    x: W - MARGIN - rnWidth, y: H - 38,
    size: 10, font: fontB,
    color: C_WHITE,
  })
  const dateLabel = fmtReceiptDate(params.paidAt)
  const dLWidth   = fontR.widthOfTextAtSize(dateLabel, 8)
  page.drawText(dateLabel, {
    x: W - MARGIN - dLWidth, y: H - 54,
    size: 8, font: fontR,
    color: C_WHITE,
    opacity: 0.85,
  })

  // ── Content ──────────────────────────────────────────────────────────────────

  let y = H - HEADER_H - 32   // starting y cursor, below header

  // ── Donor + Receipt info (two columns) ────────────────────────────────────

  drawSectionLabel(page, fonts, 'Donor', xL, y + 10)
  drawSectionLabel(page, fonts, 'Receipt', xR, y + 10)
  y -= 6
  y = drawFieldPair(page, fonts,
    { label: 'Name',           value: params.donorName   },
    { label: 'Receipt Number', value: params.receiptNumber },
    xL, xR, y,
  )
  y = drawFieldPair(page, fonts,
    { label: 'Email', value: params.donorEmail },
    { label: 'Date',  value: fmtReceiptDate(params.paidAt) },
    xL, xR, y,
  )

  y -= 12
  drawSeparator(page, MARGIN, W - MARGIN, y)
  y -= 24

  // ── Campaign info ─────────────────────────────────────────────────────────

  drawSectionLabel(page, fonts, 'Campaign', xL, y + 10)
  y -= 6
  y = drawField(page, fonts, 'Campaign Name', params.campaignTitle, xL, y)
  y = drawField(page, fonts, 'Organization',  params.organizerName, xL, y)

  y -= 12
  drawSeparator(page, MARGIN, W - MARGIN, y)
  y -= 24

  // ── Payment info ──────────────────────────────────────────────────────────

  drawSectionLabel(page, fonts, 'Payment', xL, y + 10)
  y -= 8

  // Large amount display
  const amtText  = fmtINR(params.amountRupees)
  page.drawText('AMOUNT DONATED', { x: xL, y: y + 16, size: 7.5, font: fontR, color: C_GREY })
  page.drawText(amtText, { x: xL, y, size: 28, font: fontB, color: C_ORANGE })
  y -= 42

  y = drawFieldPair(page, fonts,
    { label: 'Transaction ID',  value: params.transactionId },
    { label: 'Payment Method',  value: 'Online (Razorpay)'  },
    xL, xR, y,
  )

  // ── 80G Section ───────────────────────────────────────────────────────────

  if (params.is80G) {
    y -= 12
    drawSeparator(page, MARGIN, W - MARGIN, y)
    y -= 24

    // Section heading in emerald
    drawSectionLabel(page, fonts, '80G Tax Benefit - This donation qualifies for Income Tax deduction under Section 80G', xL, y + 10, C_EMERALD)
    y -= 6

    y = drawFieldPair(page, fonts,
      { label: 'NGO / Org PAN',         value: params.organizerPan      ?? '' },
      { label: '80G Registration No.',   value: params.reg80GNumber      ?? '' },
      xL, xR, y,
    )

    if (params.reg80GCertExpiry) {
      y = drawField(page, fonts, '80G Certificate Valid Until',
        fmtExpiryDate(params.reg80GCertExpiry), xL, y)
    }

    // Legal note
    const noteText =
      'Please retain this receipt. The tax deduction amount may vary ' +
      'based on the applicable 80G rate. Consult your tax advisor.'
    page.drawText(noteText, {
      x: MARGIN, y,
      size: 8, font: fontR,
      color: C_GREY,
      maxWidth: W - MARGIN * 2,
    })
    y -= 24
  }

  // ── Footer ────────────────────────────────────────────────────────────────

  page.drawRectangle({ x: 0, y: 0, width: W, height: 32, color: C_LIGHTGREY })
  page.drawText(
    'This is a computer-generated receipt and does not require a signature.  ' +
    'Powered by RegisterDesk · registerdesk.in',
    { x: MARGIN, y: 10, size: 7, font: fontR, color: C_GREY, maxWidth: W - MARGIN * 2 },
  )

  return pdfDoc.save()
}
