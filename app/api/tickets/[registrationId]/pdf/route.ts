// GET /api/tickets/[registrationId]/pdf
//
// Generates a downloadable PDF ticket on-the-fly.
//
// Authorization (checked in order):
//   1. ?token=<hmac>  — HMAC-SHA256(TICKET_SECRET, registrationId) signed link.
//                       Generated server-side by the ticket page and email flows.
//   2. Authorization: Bearer <firebase-id-token>  — authenticated as the
//      registration owner (reg.uid === uid) or the event organizer
//      (reg.organizerUid === uid).
//
// When TICKET_SECRET is not configured, a server warning is logged and the
// route falls back to the old UUID-as-capability-token behaviour so existing
// links keep working.  Set TICKET_SECRET in production to enable full auth.
//
// QR code is rendered as filled rectangles from the qrcode matrix so no canvas
// native module is needed.

import { NextRequest, NextResponse }   from 'next/server'
import { PDFDocument, PDFFont, StandardFonts, rgb, type RGB } from 'pdf-lib'
import { drawQrToPdf }                  from '@/lib/qr/draw'
import { adminDb, adminAuth }           from '@/lib/firebase/admin'
import { getClientIp }                  from '@/lib/rateLimit'
import { RATE_POLICY, checkPolicy }     from '@/lib/rateLimit/policies'
import { getEventBySlug }               from '@/lib/firebase/firestore/events'
import { buildQrValue, verifyTicketToken } from '@/lib/tickets/generate'
import type { RegistrationDocument }    from '@/lib/registrations/types'
import type { EventDetailsDraft }       from '@/components/wizard/eventDetailsConfig'

// ─── Colours ──────────────────────────────────────────────────────────────────

const C_PRIMARY   = rgb(229 / 255, 39 / 255, 126 / 255)   // #e5277e
const C_WHITE     = rgb(1, 1, 1)
const C_BLACK     = rgb(0, 0, 0)
const C_GREY      = rgb(0.45, 0.45, 0.45)
const C_LIGHTGREY = rgb(0.93, 0.93, 0.95)
const C_EMERALD   = rgb(4 / 255, 120 / 255, 87 / 255)     // emerald-700

// ─── WinAnsi sanitiser ────────────────────────────────────────────────────────
//
// pdf-lib's built-in standard fonts (Helvetica, Helvetica-Bold) use WinAnsi
// (Windows-1252) encoding which only covers:
//   U+0020–U+007E  printable ASCII
//   U+00A0–U+00FF  Latin-1 Supplement (accented Latin characters, ·, etc.)
//
// Any character outside those ranges — emoji, Devanagari, CJK, surrogates —
// throws "WinAnsi cannot encode …" and crashes pdfDoc.save().  Strip them
// before every drawText call that takes user-supplied content.

function sanitizePdf(str: string): string {
  // Remove anything not in the two WinAnsi printable ranges.
  // Emoji surrogate pairs (e.g. 📍 = 📍) are both outside the
  // range and are stripped correctly by the negated character class.
  return str.replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function toIso(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'object' && 'toDate' in (val as object)) {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

/** Draw QR code as a matrix of filled squares — no canvas required (shared helper). */
function drawQr(
  page:     ReturnType<PDFDocument['addPage']>,
  qrValue:  string,
  x:        number,   // left edge
  y:        number,   // bottom edge (PDF y-up)
  size:     number,   // total side length in points
): void {
  drawQrToPdf(page, qrValue, { x, y, size, color: C_BLACK })
}

/** Draw a labelled field row. Returns new y position after drawing. */
function drawField(
  page:       ReturnType<PDFDocument['addPage']>,
  fonts:      { regular: PDFFont; bold: PDFFont },
  label:      string,
  value:      string,
  x:          number,
  y:          number,
  labelColor: RGB = C_GREY,
  valueColor: RGB = C_BLACK,
): number {
  page.drawText(label.toUpperCase(), {
    x, y: y + 12,
    size: 7,
    font: fonts.regular,
    color: labelColor,
  })
  page.drawText(value, {
    x, y,
    size: 11,
    font: fonts.bold,
    color: valueColor,
  })
  return y - 32
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:    NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse> {
  const { registrationId } = await context.params

  // Throttle on-the-fly PDF generation per client IP (CPU-exhaustion guard).
  const rl = checkPolicy(getClientIp(req), RATE_POLICY.pdfDownload)
  if (rl.limited) return NextResponse.json(
    { error: 'Too many requests. Please try again later.' },
    { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
  )

  // ── Load registration ─────────────────────────────────────────────────────
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument

  // ── Authorization ─────────────────────────────────────────────────────────
  // Path 1: HMAC-signed token in query string (generated by signTicketToken).
  // Path 2: Firebase ID token — registration owner (reg.uid) or organizer.
  // Both paths require valid credentials; there is no unauthenticated fallback.
  const tokenParam = req.nextUrl.searchParams.get('token') ?? ''
  if (tokenParam) {
    if (!verifyTicketToken(registrationId, tokenParam)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    // Token verified — proceed
  } else {
    // Path 2: Firebase ID token (registration owner or organizer)
    const bearerToken = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
    let authed = false

    if (bearerToken) {
      try {
        const decoded = await adminAuth.verifyIdToken(bearerToken)
        const uid = decoded.uid
        authed = (reg.uid === uid) || (reg.organizerUid === uid)
      } catch {
        // Invalid token — fall through to 403
      }
    }

    if (!authed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const qrValue = reg.ticket?.qrValue ?? buildQrValue(reg.eventSlug, registrationId, reg.ticketCode)

  // ── Load event ────────────────────────────────────────────────────────────
  const event    = await getEventBySlug(reg.eventSlug)
  const ed       = event?.eventDetails as EventDetailsDraft | undefined
  const startDate = ed?.schedule?.startDate ?? ''
  const startTime = ed?.schedule?.startTime ?? ''
  const venueType = ed?.venue?.type
  const venueName = venueType === 'online'
    ? (ed?.venue?.online?.platform ?? 'Online')
    : (ed?.venue?.physical?.name ?? '')
  const venueCity = venueType !== 'online' ? (ed?.venue?.physical?.city ?? '') : ''

  const registeredAt = toIso(reg.registeredAt)

  // ── Build PDF ─────────────────────────────────────────────────────────────
  const pdfDoc = await PDFDocument.create()
  const fontR  = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const fontB  = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const fonts  = { regular: fontR, bold: fontB }

  // A4-ish narrow ticket: 360 × 560 points
  const W = 360
  const H = 560
  const page = pdfDoc.addPage([W, H])

  // ── Header band ──────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: H - 80, width: W, height: 80, color: C_PRIMARY })

  // Brand
  page.drawText('REGISTERDESK', {
    x: 20, y: H - 22,
    size: 8, font: fontR,
    color: C_WHITE,
    opacity: 0.7,
  })

  // Event name — sanitized: user-supplied, may contain emoji or non-Latin chars
  const evName = sanitizePdf(reg.eventName).slice(0, 46)
  page.drawText(evName, {
    x: 20, y: H - 44,
    size: 14, font: fontB,
    color: C_WHITE,
    maxWidth: W - 40,
  })

  // Date + venue meta line in header.
  // Plain text labels replace emoji (📍 etc.) — standard fonts cannot encode
  // characters outside WinAnsi and would throw on pdfDoc.save().
  const metaParts: string[] = []
  if (startDate) metaParts.push(fmt(startDate) + (startTime ? ` · ${startTime}` : ''))
  if (venueName) {
    const venueStr = sanitizePdf([venueName, venueCity].filter(Boolean).join(', '))
    if (venueStr) metaParts.push(`Venue: ${venueStr}`)
  }
  const metaLine = metaParts.join('  |  ')
  if (metaLine) {
    page.drawText(metaLine.slice(0, 72), {
      x: 20, y: H - 62,
      size: 8, font: fontR,
      color: C_WHITE,
      opacity: 0.85,
      maxWidth: W - 40,
    })
  }

  // ── QR code section ───────────────────────────────────────────────────────
  const qrSize = 130
  const qrX    = (W - qrSize) / 2
  const qrY    = H - 80 - qrSize - 20  // 20 pt below header

  // White bg behind QR
  page.drawRectangle({
    x: qrX - 8, y: qrY - 8,
    width: qrSize + 16, height: qrSize + 16,
    color: C_WHITE,
    borderColor: C_LIGHTGREY,
    borderWidth: 1,
    opacity: 1,
  })

  drawQr(page, qrValue, qrX, qrY, qrSize)

  // ── Ticket code ───────────────────────────────────────────────────────────
  const codeY = qrY - 28
  page.drawText(reg.ticketCode, {
    x: (W - fontB.widthOfTextAtSize(reg.ticketCode, 18)) / 2,
    y: codeY,
    size: 18, font: fontB,
    color: C_BLACK,
  })
  page.drawText('TICKET CODE', {
    x: (W - fontR.widthOfTextAtSize('TICKET CODE', 7)) / 2,
    y: codeY - 12,
    size: 7, font: fontR,
    color: C_GREY,
  })

  // ── Dashed separator ──────────────────────────────────────────────────────
  const sepY = codeY - 28
  page.drawLine({
    start:       { x: 20, y: sepY },
    end:         { x: W - 20, y: sepY },
    thickness:   0.5,
    color:       C_LIGHTGREY,
    dashArray:   [4, 4],
  })

  // ── Attendee fields ───────────────────────────────────────────────────────
  // All user/organizer-supplied values are sanitized before drawText.
  let y = sepY - 20

  y = drawField(page, fonts, 'Attendee', sanitizePdf(reg.attendee.name), 20, y)
  y = drawField(page, fonts, 'Pass',     sanitizePdf(reg.passName),       20, y)

  if (startDate) {
    y = drawField(page, fonts, 'Date', fmt(startDate) + (startTime ? ` · ${startTime}` : ''), 20, y)
  }
  if (venueName) {
    const venueLabel = sanitizePdf([venueName, venueCity].filter(Boolean).join(', '))
    if (venueLabel) y = drawField(page, fonts, 'Venue', venueLabel, 20, y)
  }

  const statusLabel = reg.status === 'confirmed' ? 'Confirmed'
    : reg.status === 'cancelled' ? 'Cancelled'
    : reg.status === 'pending'   ? 'Pending'
    : reg.status

  y = drawField(
    page, fonts, 'Status', statusLabel, 20, y,
    C_GREY,
    reg.status === 'confirmed' ? C_EMERALD : reg.status === 'cancelled' ? rgb(0.8, 0.1, 0.1) : C_BLACK,
  )

  if (registeredAt) {
    drawField(page, fonts, 'Registered', new Date(registeredAt).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    }), 20, y)
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: 28, color: C_LIGHTGREY })
  // · is U+00B7 (WinAnsi-safe Latin-1 Supplement)
  page.drawText('Powered by RegisterDesk · registerdesk.in', {
    x: 20, y: 9,
    size: 7, font: fontR,
    color: C_GREY,
  })

  // ── Serialize ─────────────────────────────────────────────────────────────
  const pdfBytes = await pdfDoc.save()

  return new NextResponse(Buffer.from(pdfBytes), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="ticket-${reg.ticketCode}.pdf"`,
      'Cache-Control':       'no-store',
    },
  })
}
