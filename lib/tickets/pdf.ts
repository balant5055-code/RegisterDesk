// Attendee ticket PDF generator — server-only.
//
// ═══ WHAT WAS WRONG WITH THE PREVIOUS LAYOUT ═════════════════════════════════
// The old design lived inline in the route and drew every field with a bare
// `page.drawText(value, …)` — no `maxWidth`, no wrapping, no measurement. pdf-lib does not
// clip: it simply paints past the page edge, so the text was silently LOST. On a 360×560pt
// page this was not a corner case, it was the normal case:
//
//   • "Nallammal Temple, Mangalam (Near Tirupur Rotary West), Tirupur" ended at x=359 on a
//     360pt-wide page — the real venue of a real live event, running off the edge
//   • a longer venue ended at x=555 — 195pt (54%) beyond the page, entirely invisible
//   • a long pass name ended at x=441; a long attendee name at x=375
//
// The event name and the header meta line were "handled" with `.slice(0, 46)` and
// `.slice(0, 72)` — character-count guessing, which is unrelated to rendered width and
// truncates mid-word.
//
// ═══ WHAT THIS DOES INSTEAD ══════════════════════════════════════════════════
// A4 portrait, print-safe margins, and every string laid out through `wrapText`, which
// measures with the REAL embedded font (`widthOfTextAtSize`) and hard-splits a single
// unbreakable token rather than letting it bleed. Blocks are measured before they are drawn,
// so the header band grows to fit its content instead of the content escaping the band.
//
// ═══ WHAT IS DELIBERATELY NOT TOUCHED ════════════════════════════════════════
// This module receives `qrValue`, `ticketCode` and `registrationId` as data and renders them.
// It does not derive, regenerate or alter any of them — check-in compatibility depends on the
// QR payload being byte-identical to what the route already computed.

import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from 'pdf-lib'
import { drawQrToPdf } from '@/lib/qr/draw'

// ─── Data shape ───────────────────────────────────────────────────────────────

export interface TicketData {
  /** Rendered verbatim into the QR. Computed by the caller; never derived here. */
  qrValue:        string
  ticketCode:     string
  registrationId: string
  attendeeName:   string
  passName:       string
  eventName:      string
  /** Pre-formatted, e.g. "Sat, 22 August 2026". Omitted from the ticket when absent. */
  eventDate?:     string
  eventTime?:     string
  venue?:         string
  /** Pre-formatted registration date. */
  registeredOn?:  string
  /** Raw registration status — 'confirmed' | 'cancelled' | 'pending' | … */
  status:         string
}

// ─── Page geometry ────────────────────────────────────────────────────────────

const W = 595   // A4 portrait width  (pts)
const H = 842   // A4 portrait height (pts)
const M = 48    // print-safe margin
const CONTENT_W = W - 2 * M

// ─── Palette — the RegisterDesk brand tokens the receipt PDF already uses ─────

const C_PRIMARY   = rgb(229 / 255, 39 / 255, 126 / 255)   // #e5277e
const C_PRIMARY_T = rgb(0.996, 0.945, 0.969)              // 4% wash for tinted surfaces
const C_WHITE     = rgb(1, 1, 1)
const C_INK       = rgb(0.08, 0.08, 0.10)
const C_MUTED     = rgb(0.42, 0.42, 0.47)
const C_RULE      = rgb(0.89, 0.89, 0.92)
const C_SURFACE   = rgb(0.976, 0.976, 0.984)
const C_OK        = rgb(4 / 255, 120 / 255, 87 / 255)
const C_STOP      = rgb(0.72, 0.11, 0.11)
const C_WARN      = rgb(180 / 255, 83 / 255, 9 / 255)

// ─── WinAnsi sanitiser ────────────────────────────────────────────────────────
//
// pdf-lib's standard fonts are WinAnsi-encoded and THROW on anything outside
// U+0020–U+007E / U+00A0–U+00FF. Every string reaches the page through `write()`, which
// sanitises unconditionally — the same discipline the receipt generator adopted after a
// single unsanitised literal (U+25CF) took every receipt down with a 500.

function ascii(str: string): string {
  return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim()
}

/** Greedy word wrap measured in the real font. Hard-splits an unbreakable token. */
function wrapText(str: string, font: PDFFont, size: number, maxWidth: number, maxLines: number): string[] {
  const clean = ascii(str)
  if (!clean) return []
  const lines: string[] = []
  let line = ''

  for (const word of clean.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue }
    if (line) lines.push(line)
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

  // Truncation is made visible rather than silent.
  if (lines.length === maxLines && lines.join(' ').length < clean.length) {
    let last = lines[maxLines - 1]
    while (last && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) last = last.slice(0, -1)
    lines[maxLines - 1] = `${last}...`
  }
  return lines
}

/** Presentation label + colour for a registration status. */
function statusStyle(status: string): { label: string; color: RGB } {
  switch (status) {
    case 'confirmed': return { label: 'CONFIRMED', color: C_OK }
    case 'cancelled': return { label: 'CANCELLED', color: C_STOP }
    case 'pending':   return { label: 'PENDING',   color: C_WARN }
    default:          return { label: ascii(status).toUpperCase() || 'REGISTERED', color: C_MUTED }
  }
}

// ─── Generator ───────────────────────────────────────────────────────────────

export async function generateTicketPdf(data: TicketData): Promise<Uint8Array> {
  const doc   = await PDFDocument.create()
  const fontR = await doc.embedFont(StandardFonts.Helvetica)
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold)
  const page: PDFPage = doc.addPage([W, H])

  /** The ONLY way text reaches the page. Sanitises, so no literal can crash the save. */
  const write = (
    str: string, x: number, y: number,
    o: { size?: number; bold?: boolean; color?: RGB; opacity?: number } = {},
  ): void => {
    const t = ascii(str)
    if (!t) return
    page.drawText(t, {
      x, y,
      size:  o.size ?? 10,
      font:  o.bold ? fontB : fontR,
      color: o.color ?? C_INK,
      ...(o.opacity != null ? { opacity: o.opacity } : {}),
    })
  }

  const widthOf = (s: string, size: number, bold = false) =>
    (bold ? fontB : fontR).widthOfTextAtSize(ascii(s), size)

  const writeRight = (str: string, rightX: number, y: number,
    o: { size?: number; bold?: boolean; color?: RGB; opacity?: number } = {}) =>
    write(str, rightX - widthOf(str, o.size ?? 10, o.bold), y, o)

  const writeCentre = (str: string, cx: number, y: number,
    o: { size?: number; bold?: boolean; color?: RGB } = {}) =>
    write(str, cx - widthOf(str, o.size ?? 10, o.bold) / 2, y, o)

  // ══ SECTION 1 · PREMIUM HEADER ══════════════════════════════════════════════
  // The band is MEASURED before it is drawn, so a two-line event name or a two-line venue
  // enlarges the band rather than spilling out of it.
  const nameLines  = wrapText(data.eventName, fontB, 21, CONTENT_W, 2)
  const whenParts  = [data.eventDate, data.eventTime].filter(Boolean).map(s => ascii(s!)).filter(Boolean)
  const whenLine   = whenParts.join('  |  ')
  const venueLines = data.venue ? wrapText(data.venue, fontR, 10.5, CONTENT_W, 2) : []

  const bandH =
    34 +                                  // top padding + brand line
    18 +
    nameLines.length * 25 +
    (whenLine ? 30 : 0) +
    (venueLines.length ? 14 + venueLines.length * 14 : 0) +
    26                                    // bottom padding
  const bandTop = H
  page.drawRectangle({ x: 0, y: bandTop - bandH, width: W, height: bandH, color: C_PRIMARY })

  let hy = bandTop - 34
  write('REGISTERDESK', M, hy, { size: 9, bold: true, color: C_WHITE, opacity: 0.85 })
  writeRight('EVENT TICKET', W - M, hy, { size: 8.5, color: C_WHITE, opacity: 0.7 })
  hy -= 30

  for (const line of nameLines) { write(line, M, hy, { size: 21, bold: true, color: C_WHITE }); hy -= 25 }

  if (whenLine) {
    hy -= 4
    write('DATE & TIME', M, hy + 13, { size: 7, color: C_WHITE, opacity: 0.65 })
    write(whenLine, M, hy, { size: 11, bold: true, color: C_WHITE })
    hy -= 26
  }
  if (venueLines.length) {
    hy -= 2
    write('VENUE', M, hy + 13, { size: 7, color: C_WHITE, opacity: 0.65 })
    for (const line of venueLines) { write(line, M, hy, { size: 10.5, color: C_WHITE, opacity: 0.95 }); hy -= 14 }
  }

  // ══ SECTION 2 · TICKET IDENTITY CARD ════════════════════════════════════════
  // The one element at real scale: a large QR with the code beneath it, and the three facts
  // a gate marshal actually reads — who, which pass, and whether it is valid.
  const CARD_H  = 208
  const cardTop = bandTop - bandH - 28
  const cardY   = cardTop - CARD_H
  page.drawRectangle({
    x: M, y: cardY, width: CONTENT_W, height: CARD_H,
    color: C_SURFACE, borderColor: C_RULE, borderWidth: 0.75,
  })

  // ── QR block (right) ──
  const QR = 128
  const qrBoxW = QR + 34
  const qrBoxX = M + CONTENT_W - qrBoxW - 20
  const qrX    = qrBoxX + (qrBoxW - QR) / 2
  const qrY    = cardY + CARD_H - QR - 24
  page.drawRectangle({
    x: qrBoxX, y: qrY - 12, width: qrBoxW, height: QR + 24,
    color: C_WHITE, borderColor: C_RULE, borderWidth: 0.75,
  })
  // The payload is passed through untouched — check-in scans this.
  drawQrToPdf(page, data.qrValue, { x: qrX, y: qrY, size: QR, color: C_INK })

  const qrCentre = qrBoxX + qrBoxW / 2
  writeCentre(data.ticketCode, qrCentre, qrY - 32, { size: 15, bold: true, color: C_INK })
  writeCentre('TICKET CODE', qrCentre, qrY - 44, { size: 7, color: C_MUTED })

  // ── Identity block (left) ──
  const idX = M + 24
  const idW = qrBoxX - idX - 20
  let iy = cardY + CARD_H - 34

  write('ATTENDEE', idX, iy, { size: 7, bold: true, color: C_PRIMARY })
  iy -= 18
  for (const line of wrapText(data.attendeeName, fontB, 16, idW, 2)) {
    write(line, idX, iy, { size: 16, bold: true, color: C_INK }); iy -= 19
  }
  iy -= 12

  write('PASS', idX, iy, { size: 7, bold: true, color: C_PRIMARY })
  iy -= 16
  for (const line of wrapText(data.passName, fontR, 11.5, idW, 2)) {
    write(line, idX, iy, { size: 11.5, color: C_INK }); iy -= 14
  }
  iy -= 12

  const st = statusStyle(data.status)
  write('STATUS', idX, iy, { size: 7, bold: true, color: C_PRIMARY })
  iy -= 17
  const pillW = widthOf(st.label, 8.5, true) + 18
  page.drawRectangle({
    x: idX, y: iy - 5, width: pillW, height: 17,
    color: C_WHITE, borderColor: st.color, borderWidth: 0.75,
  })
  write(st.label, idX + 9, iy, { size: 8.5, bold: true, color: st.color })

  // ══ SECTION 3 · TICKET DETAILS ══════════════════════════════════════════════
  // Deliberately NOT a repeat of the card above: attendee, pass and status are already
  // presented at full scale there, and printing them twice on one page reads as filler.
  // This grid carries the record fields, and omits any row whose value is absent — an
  // empty row is worse than no row, and "N/A" is worse than both.
  let y = cardY - 34
  write('TICKET DETAILS', M, y, { size: 8, bold: true, color: C_PRIMARY })
  y -= 8
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: C_RULE })
  y -= 20

  const LABEL_W = 150
  const VAL_X   = M + LABEL_W
  const VAL_W   = CONTENT_W - LABEL_W

  const row = (label: string, value: string | undefined | null, bold = false): void => {
    const v = ascii(value ?? '')
    if (!v) return
    write(label, M, y, { size: 9, color: C_MUTED })
    const lines = wrapText(v, bold ? fontB : fontR, 10.5, VAL_W, 2)
    for (const [i, line] of lines.entries()) write(line, VAL_X, y - i * 14, { size: 10.5, bold })
    y -= Math.max(1, lines.length) * 14 + 7
  }

  row('Event',             data.eventName, true)
  row('Date & time',       whenLine)
  row('Venue',             data.venue)
  row('Ticket code',       data.ticketCode, true)
  row('Registration ID',   data.registrationId)
  row('Registered on',     data.registeredOn)

  // ══ SECTION 4 · ENTRY INSTRUCTION ═══════════════════════════════════════════
  // Positioned relative to the flowing cursor but clamped so it can never collide with the
  // footer, whatever the content above did.
  const BOX_H  = 58
  const FOOTER = 46
  const boxY   = Math.max(FOOTER + 20, y - 14 - BOX_H)
  page.drawRectangle({
    x: M, y: boxY, width: CONTENT_W, height: BOX_H,
    color: C_PRIMARY_T, borderColor: C_PRIMARY, borderWidth: 0.6,
  })
  write('KEEP THIS TICKET READY', M + 18, boxY + BOX_H - 24, { size: 9.5, bold: true, color: C_PRIMARY })
  write('Show this QR code at the event entrance for check-in.', M + 18, boxY + BOX_H - 40,
    { size: 9.5, color: C_INK })

  // ══ SECTION 5 · FOOTER ══════════════════════════════════════════════════════
  // Anchored to the page bottom, never to the cursor.
  page.drawRectangle({ x: 0, y: 0, width: W, height: FOOTER, color: C_RULE, opacity: 0.45 })
  write('Powered by RegisterDesk', M, 26, { size: 9, bold: true, color: C_MUTED })
  write('registerdesk.in', M, 14, { size: 8.5, color: C_MUTED })
  writeRight(data.ticketCode, W - M, 20, { size: 9, bold: true, color: C_MUTED })

  return doc.save()
}
