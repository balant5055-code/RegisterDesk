// Certificate PDF generator — server-only.
// Produces A4-landscape (842 × 595 pt) PDF certificates using pdf-lib.
// No canvas module required — QR is drawn as filled rectangles.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { drawQrToPdf }                       from '@/lib/qr/draw'
import { validateStorageUrl, safeFetchBytes } from './urlGuard'
import type { CertificateTemplate, CertificateRecord } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

const W = 842   // A4 landscape width (pts)
const H = 595   // A4 landscape height (pts)

const C_PRIMARY = rgb(229 / 255,  39 / 255, 126 / 255)   // #e5277e
const C_WHITE   = rgb(1, 1, 1)
const C_DARK    = rgb(0.1, 0.1, 0.1)
const C_GREY    = rgb(0.45, 0.45, 0.45)
const C_LTGREY  = rgb(0.88, 0.88, 0.90)
const C_GOLD    = rgb(0.72, 0.56, 0.14)

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Strip characters outside WinAnsi range (same guard as ticket PDF).
function sanitize(s: string): string {
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, '')
}

// Draw QR as filled rectangles — no canvas required.
type Page = ReturnType<PDFDocument['addPage']>

function drawQr(page: Page, value: string, x: number, y: number, size: number): void {
  drawQrToPdf(page, value, { x, y, size, color: C_DARK })
}

// Fetch an image URL and return bytes, or null on failure (non-fatal).
// SSRF-guarded: only Firebase Storage URLs for the configured bucket are
// fetched, with no redirect following. Organizer-supplied logo/signature/
// background URLs that aren't in our bucket are skipped (image simply omitted).
async function fetchImageBytes(url: string | undefined): Promise<Uint8Array | null> {
  if (!url) return null
  const check = validateStorageUrl(url)
  if (!check.ok) return null
  return safeFetchBytes(url, check, { timeoutMs: 5000 }).catch(() => null)
}

// Returns true when bytes look like a JPEG (magic: FF D8).
function isJpeg(b: Uint8Array): boolean {
  return b.length > 1 && b[0] === 0xff && b[1] === 0xd8
}

// ─── Main generator ───────────────────────────────────────────────────────────

/**
 * Generates an A4-landscape PDF certificate.
 *
 * @param template   Certificate template (design config from Firestore)
 * @param record     Certificate record (attendee + event data)
 * @param verifyUrl  Absolute URL for the QR code (e.g. https://…/verify/certificate/RDC-…)
 * @param issueDate  Pre-formatted issue date string, e.g. "8 June 2026"
 */
export async function generateCertificatePdf(
  template:  CertificateTemplate,
  record:    CertificateRecord,
  verifyUrl: string,
  issueDate: string,
): Promise<Uint8Array> {
  const doc   = await PDFDocument.create()
  const fontR = await doc.embedFont(StandardFonts.Helvetica)
  const fontB = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontI = await doc.embedFont(StandardFonts.HelveticaOblique)

  const page = doc.addPage([W, H])

  // ── Optional background image ─────────────────────────────────────────────
  const bgBytes = await fetchImageBytes(template.backgroundUrl)
  if (bgBytes) {
    try {
      const bgImg = isJpeg(bgBytes)
        ? await doc.embedJpg(bgBytes)
        : await doc.embedPng(bgBytes)
      page.drawImage(bgImg, { x: 0, y: 0, width: W, height: H, opacity: 0.12 })
    } catch { /* non-fatal */ }
  }

  // ── Decorative border (double rule) ───────────────────────────────────────
  page.drawRectangle({ x: 16, y: 16, width: W - 32, height: H - 32, borderColor: C_GOLD, borderWidth: 1.5, opacity: 0 })
  page.drawRectangle({ x: 20, y: 20, width: W - 40, height: H - 40, borderColor: C_GOLD, borderWidth: 0.5, opacity: 0 })

  // ── Accent bars (primary colour) ──────────────────────────────────────────
  page.drawRectangle({ x:  0, y: H - 10, width: W, height: 10, color: C_PRIMARY })  // top
  page.drawRectangle({ x:  0, y:  0,     width: W, height: 10, color: C_PRIMARY })  // bottom
  page.drawRectangle({ x:  0, y:  0,     width: 10, height: H, color: C_PRIMARY })  // left
  page.drawRectangle({ x: W - 10, y: 0,  width: 10, height: H, color: C_PRIMARY })  // right

  // ── Optional org logo (top-left) ─────────────────────────────────────────
  let headerTextX = 40
  const logoBytes = await fetchImageBytes(template.logoUrl)
  if (logoBytes) {
    try {
      const logo   = isJpeg(logoBytes) ? await doc.embedJpg(logoBytes) : await doc.embedPng(logoBytes)
      const logoH  = 38
      const logoW  = Math.min(logo.width * (logoH / logo.height), 110)
      page.drawImage(logo, { x: 40, y: H - 72, width: logoW, height: logoH })
      headerTextX = 40 + logoW + 12
    } catch { /* non-fatal */ }
  }

  // ── Top header row ────────────────────────────────────────────────────────
  const topBaseY = H - 50
  // RegisterDesk label (small, left)
  page.drawText('REGISTERDESK', {
    x: headerTextX, y: topBaseY,
    size: 7, font: fontR, color: C_PRIMARY, opacity: 0.7,
  })

  // Issued by (right-aligned)
  const issuedByText = sanitize(template.issuedBy || 'RegisterDesk')
  const ibtW = fontB.widthOfTextAtSize(issuedByText, 10)
  page.drawText(issuedByText, {
    x: W - 40 - ibtW, y: topBaseY,
    size: 10, font: fontB, color: C_DARK,
  })

  // ── Thin gold divider below header ────────────────────────────────────────
  const div1Y = H - 88
  page.drawLine({ start: { x: 40, y: div1Y }, end: { x: W - 40, y: div1Y }, thickness: 0.6, color: C_GOLD })

  // ── Certificate title ────────────────────────────────────────────────────
  const title     = sanitize(template.title || 'Certificate of Participation')
  const titleSize = 22
  const titleW    = fontB.widthOfTextAtSize(title, titleSize)
  page.drawText(title, {
    x: (W - titleW) / 2, y: H - 130,
    size: titleSize, font: fontB, color: C_PRIMARY,
  })

  // Gold underline accent below title
  const ulHalf = Math.min((titleW + 60) / 2, 180)
  page.drawLine({
    start: { x: W / 2 - ulHalf, y: H - 140 },
    end:   { x: W / 2 + ulHalf, y: H - 140 },
    thickness: 1.5, color: C_GOLD,
  })

  // ── Subtitle ─────────────────────────────────────────────────────────────
  const subtitle = sanitize(template.subtitle || 'This is to certify that')
  const stW = fontI.widthOfTextAtSize(subtitle, 11)
  page.drawText(subtitle, {
    x: (W - stW) / 2, y: H - 172,
    size: 11, font: fontI, color: C_GREY,
  })

  // ── Participant name (large, centered) ───────────────────────────────────
  const nameRaw  = sanitize(record.attendeeName)
  const nameSize = 30
  const nameW    = fontB.widthOfTextAtSize(nameRaw, nameSize)
  page.drawText(nameRaw, {
    x: (W - Math.min(nameW, W - 160)) / 2, y: H - 218,
    size:     nameSize,
    font:     fontB,
    color:    C_DARK,
    maxWidth: W - 160,
  })

  // ── Body text (participation / completion) ────────────────────────────────
  const bodyText = sanitize(
    template.type === 'completion'
      ? 'has successfully completed'
      : 'has successfully participated in',
  )
  const btW = fontR.widthOfTextAtSize(bodyText, 12)
  page.drawText(bodyText, {
    x: (W - btW) / 2, y: H - 258,
    size: 12, font: fontR, color: C_GREY,
  })

  // ── Event name ────────────────────────────────────────────────────────────
  const eventName = sanitize(record.eventName).slice(0, 60)
  const enSize    = 17
  const enW       = fontB.widthOfTextAtSize(eventName, enSize)
  page.drawText(eventName, {
    x: (W - Math.min(enW, W - 160)) / 2, y: H - 288,
    size:     enSize,
    font:     fontB,
    color:    C_DARK,
    maxWidth: W - 160,
  })

  // ── Event date ────────────────────────────────────────────────────────────
  if (record.eventDate) {
    const dtText = `Held on: ${sanitize(record.eventDate)}`
    const dtW    = fontR.widthOfTextAtSize(dtText, 10)
    page.drawText(dtText, {
      x: (W - dtW) / 2, y: H - 313,
      size: 10, font: fontR, color: C_GREY,
    })
  }

  // ── Divider above signature area ──────────────────────────────────────────
  const div2Y = H - 345
  page.drawLine({ start: { x: 40, y: div2Y }, end: { x: W - 40, y: div2Y }, thickness: 0.4, color: C_LTGREY })

  // ── Signature section (left half) ────────────────────────────────────────
  const sigBaseY = H - 405
  const sigBytes = await fetchImageBytes(template.signatureUrl)
  if (sigBytes) {
    try {
      const sigImg  = isJpeg(sigBytes) ? await doc.embedJpg(sigBytes) : await doc.embedPng(sigBytes)
      const sigH    = 32
      const sigW    = Math.min(sigImg.width * (sigH / sigImg.height), 100)
      page.drawImage(sigImg, { x: 60, y: sigBaseY, width: sigW, height: sigH, opacity: 0.88 })
    } catch { /* non-fatal */ }
  } else {
    // Placeholder line
    page.drawLine({
      start: { x: 60, y: sigBaseY }, end: { x: 180, y: sigBaseY },
      thickness: 0.8, color: C_DARK, opacity: 0.25,
    })
  }

  const sigName = sanitize(template.signatoryName)
  if (sigName) {
    page.drawText(sigName, {
      x: 60, y: sigBaseY - 18, size: 10, font: fontB, color: C_DARK,
    })
  }
  const sigDesig = sanitize(template.signatoryDesignation)
  if (sigDesig) {
    page.drawText(sigDesig, {
      x: 60, y: sigBaseY - 32, size: 9, font: fontR, color: C_GREY,
    })
  }
  page.drawText(sanitize(template.issuedBy || 'RegisterDesk'), {
    x: 60, y: sigBaseY - 45, size: 9, font: fontR, color: C_GREY,
  })

  // ── QR code (bottom-right) ────────────────────────────────────────────────
  const qrSize = 72
  const qrX    = W - 40 - qrSize
  const qrY    = 40
  page.drawRectangle({
    x: qrX - 4, y: qrY - 4, width: qrSize + 8, height: qrSize + 8,
    color: C_WHITE, borderColor: C_LTGREY, borderWidth: 0.5,
  })
  drawQr(page, verifyUrl, qrX, qrY, qrSize)

  const vLabel = 'Scan to verify'
  const vlW    = fontR.widthOfTextAtSize(vLabel, 7)
  page.drawText(vLabel, {
    x: qrX + (qrSize - vlW) / 2, y: qrY + qrSize + 5,
    size: 7, font: fontR, color: C_GREY,
  })

  // ── Certificate meta (bottom-left) ────────────────────────────────────────
  const metaBaseY = 60
  page.drawText(`Certificate ID: ${sanitize(record.certificateId)}`, {
    x: 40, y: metaBaseY + 10, size: 8, font: fontR, color: C_GREY,
  })
  page.drawText(`Issue Date: ${sanitize(issueDate)}`, {
    x: 40, y: metaBaseY - 2, size: 8, font: fontR, color: C_GREY,
  })
  const shortUrl = sanitize(verifyUrl.replace(/^https?:\/\//, ''))
  page.drawText(shortUrl.slice(0, 65), {
    x: 40, y: metaBaseY - 14, size: 7, font: fontR, color: C_PRIMARY, opacity: 0.8,
  })

  return doc.save()
}
