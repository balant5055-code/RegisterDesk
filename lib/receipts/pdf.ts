// Receipt PDF generator — server-only.
// Produces an A4 portrait (595 × 842 pt) payment receipt using pdf-lib. No canvas module.
//
// ═══ THE CRASH THIS FILE USED TO HAVE ════════════════════════════════════════
// Every receipt request returned HTTP 500. The generator drew a hardcoded bullet — '●  Paid'
// (U+25CF) — directly, bypassing the WinAnsi sanitiser that guarded every other string.
// pdf-lib's StandardFonts are WinAnsi-encoded and cover only U+0020–U+007E and U+00A0–U+00FF,
// so the draw threw `WinAnsi cannot encode "●" (0x25cf)` for EVERY registration, whatever its
// data. It was never a missing field, a payment problem, or bad input.
//
// The structural fix is not "delete that character": it is that a raw `drawText` is no longer
// reachable from this file's body. Everything goes through `write()`/`writeRight()`, which
// sanitise unconditionally, so a future literal cannot reintroduce the same failure.
//
// ═══ WHY "INR" AND NOT "₹" ═══════════════════════════════════════════════════
// U+20B9 (₹) is outside WinAnsi too and would crash in exactly the same way. Currency is
// rendered as "INR 1,500.00". Do not "improve" this to the glyph without embedding a
// Unicode font first.
//
// ═══ WHAT THIS DOES NOT DO ═══════════════════════════════════════════════════
// Nothing here is persisted. The receipt is generated per request from the CURRENT
// registration document and streamed back with `Cache-Control: no-store` — there is no
// stored artifact, no cache key and no invalidation to reason about. An edited attendee name
// therefore appears on the very next download by construction.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib'

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

  // Optional context — each section is omitted entirely when its data is absent, so a
  // sparse registration produces a shorter receipt rather than a page of "N/A".
  attendeePhone?:    string
  eventDate?:        string   // pre-formatted
  venue?:            string
  registrationDate?: string   // pre-formatted
  paymentStatus?:    string   // 'paid' | 'refunded' | …
  quantity?:         number
  subtotalPaise?:    number   // originalAmount, before discount
  discountPaise?:    number
  couponCode?:       string

  // Optional future fields — not rendered when absent
  invoiceNumber?:  string    // sequential invoice number once implemented
  gstNumber?:      string    // organizer GSTIN, e.g. "27AADCB2230M1ZT"
  gstRate?:        number    // e.g. 18 (for 18%)
  taxableAmount?:  number    // paise — amount before tax (for breakdown)

  // RD-PAYMENT-05 B1: attendee fee breakdown lines (attendee_pays only). Each is a
  // canonical stored paise value; rendered as itemised rows above the total.
  feeLines?: { label: string; paise: number }[]
}

// ─── Page geometry ────────────────────────────────────────────────────────────

const W = 595   // A4 portrait width (pts)
const H = 842   // A4 portrait height (pts)
const M = 48    // page margin — print-safe on every consumer printer
const CONTENT_W = W - 2 * M
const LABEL_W   = 150                  // left column of the label/value grid
const VALUE_X   = M + LABEL_W
const VALUE_W   = CONTENT_W - LABEL_W

// ─── Colours (the same brand tokens the ticket PDF uses) ──────────────────────

const C_PRIMARY = rgb(229 / 255, 39 / 255, 126 / 255)   // #e5277e
const C_WHITE   = rgb(1, 1, 1)
const C_DARK    = rgb(0.08, 0.08, 0.10)
const C_GREY    = rgb(0.42, 0.42, 0.45)
const C_RULE    = rgb(0.89, 0.89, 0.92)
const C_EMERALD = rgb(4 / 255, 120 / 255, 87 / 255)
const C_AMBER   = rgb(180 / 255, 83 / 255, 9 / 255)

// ─── WinAnsi sanitiser ────────────────────────────────────────────────────────
//
// The ONLY way text reaches the page. See the header comment: making this unavoidable is
// the actual fix, because the previous bug was a single literal that skipped it.

function ascii(str: string): string {
  return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim()
}

/** Greedy word wrap, measured in the real font — long names/venues wrap, never overflow. */
function wrapText(str: string, font: PDFFont, size: number, maxWidth: number, maxLines = 3): string[] {
  const clean = ascii(str)
  if (!clean) return []
  const words = clean.split(/\s+/)
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue }
    if (line) lines.push(line)
    // A single word wider than the column (a long URL, an unbroken name) is hard-split
    // rather than allowed to bleed past the margin.
    if (font.widthOfTextAtSize(word, size) > maxWidth) {
      let chunk = ''
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) { lines.push(chunk); chunk = ch }
        else chunk += ch
      }
      line = chunk
    } else {
      line = word
    }
    if (lines.length >= maxLines) break
  }
  if (line && lines.length < maxLines) lines.push(line)

  // Ellipsise the last line if content was truncated, so a clip is visible not silent.
  if (lines.length === maxLines) {
    const consumed = lines.join(' ')
    if (consumed.length < clean.length) {
      let last = lines[maxLines - 1]
      while (last && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) last = last.slice(0, -1)
      lines[maxLines - 1] = `${last}...`
    }
  }
  return lines
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
  const page: PDFPage = doc.addPage([W, H])

  /** Sanitising draw. Nothing in this file may call page.drawText directly. */
  const write = (
    str: string, x: number, y: number,
    opts: { size?: number; bold?: boolean; color?: RGB; opacity?: number } = {},
  ): void => {
    const t = ascii(str)
    if (!t) return
    page.drawText(t, {
      x, y,
      size:  opts.size ?? 10,
      font:  opts.bold ? fontB : fontR,
      color: opts.color ?? C_DARK,
      ...(opts.opacity != null ? { opacity: opts.opacity } : {}),
    })
  }

  /** Right-aligned draw — how every currency column stays on a true right edge. */
  const writeRight = (
    str: string, rightX: number, y: number,
    opts: { size?: number; bold?: boolean; color?: RGB } = {},
  ): void => {
    const t = ascii(str)
    if (!t) return
    const size = opts.size ?? 10
    const font = opts.bold ? fontB : fontR
    write(t, rightX - font.widthOfTextAtSize(t, size), y, opts)
  }

  const rule = (y: number): void => {
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: C_RULE })
  }

  // ══ HEADER BAND ═════════════════════════════════════════════════════════════
  const HEADER_H = 104
  page.drawRectangle({ x: 0, y: H - HEADER_H, width: W, height: HEADER_H, color: C_PRIMARY })

  write('REGISTERDESK', M, H - 32, { size: 9, color: C_WHITE, opacity: 0.8 })
  write('Payment Receipt', M, H - 60, { size: 22, bold: true, color: C_WHITE })
  write(ascii(data.organizerName), M, H - 82, { size: 9.5, color: C_WHITE, opacity: 0.85 })

  // Status badge, right-aligned in the band. A refunded receipt must not claim "PAID".
  const refunded = (data.paymentStatus ?? 'paid').toLowerCase() === 'refunded'
  const badge    = refunded ? 'REFUNDED' : 'PAID'
  const badgeW   = fontB.widthOfTextAtSize(badge, 10) + 24
  page.drawRectangle({
    x: W - M - badgeW, y: H - 56, width: badgeW, height: 24,
    color: C_WHITE, opacity: 0.18,
    borderColor: C_WHITE, borderWidth: 0.75, borderOpacity: 0.55,
  })
  writeRight(badge, W - M - 12, H - 49, { size: 10, bold: true, color: C_WHITE })

  // ══ LAYOUT CURSOR ═══════════════════════════════════════════════════════════
  let y = H - HEADER_H - 34

  const section = (title: string): void => {
    write(title, M, y, { size: 8, bold: true, color: C_PRIMARY })
    y -= 6
    rule(y)
    y -= 18
  }

  /** One label/value row. The value wraps inside its column and the row grows to fit. */
  const row = (label: string, value: string | undefined | null, opts: { bold?: boolean } = {}): void => {
    const v = ascii(value ?? '')
    if (!v) return                                   // absent optional field → no empty row
    write(label, M, y, { size: 9, color: C_GREY })
    const lines = wrapText(v, opts.bold ? fontB : fontR, 10, VALUE_W, 3)
    for (const [i, line] of lines.entries()) {
      write(line, VALUE_X, y - i * 13, { size: 10, bold: opts.bold })
    }
    y -= Math.max(1, lines.length) * 13 + 6
  }

  /** A money row: label left, amount right-aligned on the page's right margin. */
  const money = (label: string, paise: number, opts: { bold?: boolean; color?: RGB } = {}): void => {
    write(label, M, y, { size: 9.5, bold: opts.bold, color: opts.color ?? C_GREY })
    writeRight(fmtINR(paise), W - M, y, { size: 9.5, bold: opts.bold, color: opts.color ?? C_DARK })
    y -= 18
  }

  // ══ RECEIPT DETAILS ═════════════════════════════════════════════════════════
  section('RECEIPT DETAILS')
  row('Receipt number',   data.invoiceNumber ?? `RD-${data.registrationId.slice(-10).toUpperCase()}`)
  row('Registration ID',  data.registrationId)
  row('Ticket code',      data.ticketCode)
  row('Registration date', data.registrationDate)
  y -= 8

  // ══ ATTENDEE ════════════════════════════════════════════════════════════════
  section('ATTENDEE')
  row('Name',  data.attendeeName, { bold: true })
  row('Email', data.attendeeEmail)
  row('Phone', data.attendeePhone)
  y -= 8

  // ══ EVENT ═══════════════════════════════════════════════════════════════════
  section('EVENT')
  row('Event', data.eventName, { bold: true })
  row('Date',  data.eventDate)
  row('Venue', data.venue)
  y -= 8

  // ══ REGISTRATION ════════════════════════════════════════════════════════════
  section('REGISTRATION')
  row('Pass / category', data.passName)
  if (data.quantity != null && data.quantity > 1) row('Quantity', String(data.quantity))
  y -= 8

  // ══ PAYMENT ═════════════════════════════════════════════════════════════════
  section('PAYMENT')

  // Itemised lines when the canonical breakdown is available; otherwise a subtotal.
  if (data.feeLines && data.feeLines.length > 0) {
    for (const line of data.feeLines) money(line.label, line.paise)
  } else if (data.subtotalPaise != null && data.subtotalPaise !== data.amountPaid) {
    money('Subtotal', data.subtotalPaise)
  }

  if (data.discountPaise != null && data.discountPaise > 0) {
    const label = data.couponCode ? `Discount (${ascii(data.couponCode)})` : 'Discount'
    write(label, M, y, { size: 9.5, color: C_GREY })
    writeRight(`- ${fmtINR(data.discountPaise)}`, W - M, y, { size: 9.5, color: C_EMERALD })
    y -= 18
  }

  if (data.gstRate != null && data.taxableAmount != null) {
    money(`GST (${data.gstRate}%)`, Math.round(data.taxableAmount * data.gstRate / 100))
  }

  // Total — the one figure that must never be ambiguous.
  y -= 2
  rule(y + 10)
  y -= 6
  write('Total paid', M, y, { size: 12, bold: true })
  writeRight(fmtINR(data.amountPaid), W - M, y, { size: 14, bold: true, color: refunded ? C_AMBER : C_EMERALD })
  y -= 22
  rule(y + 8)
  y -= 14

  row('Payment status',    refunded ? 'Refunded' : 'Paid')
  row('Payment reference', data.paymentId)
  row('Transaction date',  data.transactionDate)
  if (data.gstNumber) row('GSTIN', data.gstNumber)

  // ══ FOOTER ══════════════════════════════════════════════════════════════════
  // Anchored to the page bottom, never to the flowing cursor, so a short receipt does not
  // leave the footer floating mid-page and a long one cannot push it off.
  const FOOTER_H = 44
  page.drawRectangle({ x: 0, y: 0, width: W, height: FOOTER_H, color: C_RULE, opacity: 0.5 })
  write('RegisterDesk', M, 26, { size: 9, bold: true, color: C_GREY })
  write('registerdesk.in', M, 14, { size: 8.5, color: C_GREY })
  writeRight('This is a system-generated receipt and does not require a signature.',
    W - M, 14, { size: 7.5, color: C_GREY })

  return doc.save()
}
