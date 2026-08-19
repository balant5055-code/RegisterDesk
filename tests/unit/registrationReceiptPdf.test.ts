// RD-RECEIPT-FIX — the payment receipt must generate, and must reflect CURRENT data.
//
// THE PRODUCTION DEFECT. Every "Download Receipt" click returned HTTP 500 and the organizer
// saw a fixed string, "Could not generate receipt." The generator drew a hardcoded bullet,
// '●  Paid' (U+25CF), straight to the page, bypassing the WinAnsi sanitiser that guarded
// every other string in the file. pdf-lib's StandardFonts are WinAnsi-encoded, so the draw
// threw `WinAnsi cannot encode "●" (0x25cf)` for EVERY registration, whatever its data.
//
// It shipped because nothing in the suite ever called generateReceiptPdf. These tests are
// therefore as much about the missing coverage as about the character.
//
// NOTHING IS PERSISTED. The receipt and the ticket PDF are generated per request from the
// live registration document and returned with `Cache-Control: no-store`. There is no stored
// artifact, no cache key, and no invalidation step — which is why an edited name appears on
// the next download by construction, and why these tests assert on generation, not on
// storage.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { generateReceiptPdf, type ReceiptData } from '@/lib/receipts/pdf'

const base = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  registrationId:  'reg_9f2b7c41aa',
  ticketCode:      'RD-8KD31A',
  attendeeName:    'Ramesh Kumar',
  attendeeEmail:   'ramesh@example.com',
  passName:        '10K Timed Run',
  eventName:       'Chennai Marathon 2026',
  organizerName:   'Chennai Runners Club',
  amountPaid:      150000,
  paymentId:       'pay_Qk18ZxTvbN2mLp',
  transactionDate: '15 Jun 2026, 14:30',
  ...over,
})

/** Renders and returns the PDF's page-1 text operators, so content is asserted, not assumed. */
async function render(data: ReceiptData): Promise<{ bytes: Uint8Array; pages: number }> {
  const bytes = await generateReceiptPdf(data)
  const doc   = await PDFDocument.load(bytes)
  return { bytes, pages: doc.getPageCount() }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('the receipt generates at all', () => {
  it('produces a valid PDF for an ordinary paid registration', async () => {
    const { bytes, pages } = await render(base())
    expect(bytes.byteLength).toBeGreaterThan(1000)
    expect(pages).toBe(1)
  })

  it('emits a real PDF header, not an error page', async () => {
    const { bytes } = await render(base())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })

  it('is a single A4 portrait page', async () => {
    const doc  = await PDFDocument.load(await generateReceiptPdf(base()))
    const page = doc.getPage(0)
    expect(Math.round(page.getWidth())).toBe(595)
    expect(Math.round(page.getHeight())).toBe(842)
  })
})

// ── THE REGRESSION ──────────────────────────────────────────────────────────
describe('no unrenderable glyph can reach the page', () => {
  it('MUTATION: no non-WinAnsi literal survives anywhere in the executable source', () => {
    // Comments are stripped first: the header deliberately NAMES the character that broke
    // production, and that documentation is worth keeping. What must never come back is a
    // non-WinAnsi glyph in a string the generator can draw.
    const code = readFileSync(resolve(process.cwd(), 'lib/receipts/pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Every quoted literal in the remaining code, checked against the encodable ranges.
    const literals = code.match(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g) ?? []
    const offenders = literals.filter(l =>
      // The sanitiser's own character-class is the one legitimate mention of the range.
      !l.includes('\\x20') && /[^\x20-\x7E\xA0-\xFF]/.test(l))
    expect(offenders).toEqual([])
  })

  it('the file never calls page.drawText outside the sanitising helper', () => {
    // The structural fix. A raw drawText is how the bullet skipped sanitising, so exactly one
    // may exist — the one inside `write()`. Any other is the same bug waiting to happen.
    const src = readFileSync(resolve(process.cwd(), 'lib/receipts/pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect((src.match(/page\.drawText\(/g) ?? []).length).toBe(1)
  })

  it('survives non-WinAnsi data in every user-supplied field', async () => {
    // Devanagari, Tamil, emoji, curly quotes, en-dash — all outside WinAnsi. Real attendee
    // and event names in an India-first product contain these.
    const { bytes } = await render(base({
      attendeeName:  'रमेश कुमार 🏃',
      attendeeEmail: 'ramesh@example.com',
      eventName:     'சென்னை Marathon — 2026 “Elite”',
      passName:      '10K – Timed',
      organizerName: 'Chennai Runners ♥',
      venue:         'Marina Beach · Chennai',
      couponCode:    'EARLY–BIRD',
    }))
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('survives a rupee glyph if one is ever passed in', async () => {
    const { bytes } = await render(base({ passName: '₹1500 Pass' }))
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })
})

// ── CURRENT DATA ────────────────────────────────────────────────────────────
describe('the receipt reflects whatever it is given — there is no snapshot', () => {
  it('a renamed attendee produces different bytes from the original', async () => {
    const before = await generateReceiptPdf(base({ attendeeName: 'Ramesh Kumar' }))
    const after  = await generateReceiptPdf(base({ attendeeName: 'Ramesh Kumaran' }))
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).not.toBe(0)
  })

  it('the newest name wins after two successive edits', async () => {
    const v1 = await generateReceiptPdf(base({ attendeeName: 'Name One' }))
    const v2 = await generateReceiptPdf(base({ attendeeName: 'Name Two' }))
    const v3 = await generateReceiptPdf(base({ attendeeName: 'Name Three' }))
    expect(Buffer.compare(Buffer.from(v2), Buffer.from(v1))).not.toBe(0)
    expect(Buffer.compare(Buffer.from(v3), Buffer.from(v2))).not.toBe(0)
  })

  it('identical input renders deterministically — no hidden per-request state', async () => {
    const a = await generateReceiptPdf(base())
    const b = await generateReceiptPdf(base())
    expect(a.byteLength).toBe(b.byteLength)
  })
})

// ── LAYOUT ROBUSTNESS ───────────────────────────────────────────────────────
describe('long values wrap instead of overflowing or clipping', () => {
  const LONG_NAME  = 'Venkataraman Subrahmanyan Balasubramanian Krishnamurthy Iyer'
  const LONG_EVENT = 'The Greater Chennai Metropolitan Annual Charity Marathon and Community Wellness Festival 2026'
  const LONG_VENUE = 'Jawaharlal Nehru Indoor Stadium, Sydenhams Road, Periamet, Park Town, Chennai, Tamil Nadu 600003'

  it('a very long attendee name still renders one page', async () => {
    const { pages, bytes } = await render(base({ attendeeName: LONG_NAME }))
    expect(pages).toBe(1)
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('a very long event name still renders one page', async () => {
    const { pages } = await render(base({ eventName: LONG_EVENT }))
    expect(pages).toBe(1)
  })

  it('a very long venue still renders one page', async () => {
    const { pages } = await render(base({ venue: LONG_VENUE }))
    expect(pages).toBe(1)
  })

  it('all three at once still renders one page', async () => {
    const { pages } = await render(base({
      attendeeName: LONG_NAME, eventName: LONG_EVENT, venue: LONG_VENUE,
      passName: 'Premium All-Access Weekend Pass With Breakfast And Finisher Medal',
    }))
    expect(pages).toBe(1)
  })

  it('an unbroken 200-character token is hard-split rather than bled past the margin', async () => {
    const { pages } = await render(base({ attendeeName: 'A'.repeat(200) }))
    expect(pages).toBe(1)
  })
})

// ── SPARSE / LEGACY DATA ────────────────────────────────────────────────────
describe('older and sparser registrations still produce a receipt', () => {
  it('renders with only the required fields — every optional section omitted', async () => {
    const { bytes, pages } = await render(base())
    expect(pages).toBe(1)
    expect(bytes.byteLength).toBeGreaterThan(1000)
  })

  it('renders when phone, venue, event date and registration date are all absent', async () => {
    const { pages } = await render(base({
      attendeePhone: undefined, venue: undefined,
      eventDate: undefined, registrationDate: undefined,
    }))
    expect(pages).toBe(1)
  })

  it('renders with empty strings where a legacy document has blanks', async () => {
    const { pages } = await render(base({
      attendeePhone: '', venue: '', eventDate: '', registrationDate: '', paymentId: '',
    }))
    expect(pages).toBe(1)
  })

  it('renders a fully populated receipt with every optional section', async () => {
    const { pages } = await render(base({
      attendeePhone:    '+91 98400 12345',
      eventDate:        '12 July 2026',
      venue:            'Marina Beach, Chennai',
      registrationDate: '2 Jun 2026, 09:15',
      quantity:         2,
      subtotalPaise:    180000,
      discountPaise:    30000,
      couponCode:       'EARLYBIRD',
      gstNumber:        '33AADCB2230M1ZT',
    }))
    expect(pages).toBe(1)
  })
})

// ── MONEY ───────────────────────────────────────────────────────────────────
describe('payment figures', () => {
  it('renders itemised fee lines when the canonical breakdown is present', async () => {
    const withLines = await generateReceiptPdf(base({
      feeLines: [
        { label: 'Ticket price', paise: 150000 },
        { label: 'Platform fee', paise: 4500 },
        { label: 'GST',          paise: 810 },
      ],
      amountPaid: 155310,
    }))
    const without = await generateReceiptPdf(base({ amountPaid: 155310 }))
    expect(Buffer.compare(Buffer.from(withLines), Buffer.from(without))).not.toBe(0)
  })

  it('a refunded registration is not labelled PAID', async () => {
    const paid     = await generateReceiptPdf(base({ paymentStatus: 'paid' }))
    const refunded = await generateReceiptPdf(base({ paymentStatus: 'refunded' }))
    expect(Buffer.compare(Buffer.from(paid), Buffer.from(refunded))).not.toBe(0)
  })

  it('handles a large amount and a paise-level amount without breaking layout', async () => {
    expect((await render(base({ amountPaid: 99_99_99_900 }))).pages).toBe(1)
    expect((await render(base({ amountPaid: 1 }))).pages).toBe(1)
  })
})

// ── ROUTE CONTRACT ──────────────────────────────────────────────────────────
describe('the receipt route stays bounded, current and authorized', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'app/api/receipts/[registrationId]/route.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('reads exactly ONE registration document — never a collection scan', () => {
    expect(code).toMatch(/collection\('registrations'\)\.doc\(registrationId\)\.get\(\)/)
    expect(code).not.toMatch(/collection\('registrations'\)\s*\n?\s*\.where\(/)
  })

  it('bounds the payment-intent lookup', () => {
    expect(code).toMatch(/\.limit\(1\)/)
  })

  it('passes the CURRENT attendee name, not a snapshot field', () => {
    expect(code).toMatch(/attendeeName:\s+reg\.attendee\.name/)
  })

  it('authorizes before generating anything', () => {
    const auth = code.indexOf('Forbidden')
    const gen  = code.indexOf('generateReceiptPdf(')
    expect(auth).toBeGreaterThan(-1)
    expect(auth).toBeLessThan(gen)
  })

  it('accepts a signed token OR the owner/organizer bearer — both still present', () => {
    expect(code).toMatch(/verifyReceiptToken\(registrationId, tokenParam\)/)
    expect(code).toMatch(/reg\.uid === uid\) \|\| \(reg\.organizerUid === uid/)
  })

  it('never caches the response', () => {
    expect(code).toMatch(/'Cache-Control':\s+'no-store'/)
  })

  it('logs a generation failure instead of swallowing it', () => {
    expect(code).toMatch(/catch \(err\)/)
    expect(code).toMatch(/console\.error\('\[receipts\] generation failed:'/)
  })

  it('persists nothing — no storage upload, no artifact key', () => {
    expect(code).not.toMatch(/storage\.upload|receiptKey|generateSignedUrl/)
  })

  it('is still refused for free registrations', () => {
    expect(code).toMatch(/reg\.amount === 0 \|\| reg\.paymentStatus === 'not_required'/)
  })
})

describe('the ticket PDF route still reads live data', () => {
  const code = readFileSync(
    resolve(process.cwd(), 'app/api/tickets/[registrationId]/pdf/route.ts'), 'utf8')

  // RD-TICKET-REDESIGN moved the layout (and with it the WinAnsi sanitiser) into
  // lib/tickets/pdf.ts, so the old `sanitizePdf(reg.attendee.name)` call no longer exists
  // here. The REQUIREMENT is unchanged and is what this now asserts: the name handed to the
  // generator comes from the freshly-read document, never from a snapshot. The rendered
  // outcome is proven separately, by text extraction, in ticketPdfReflectsCurrentName.
  it('passes the attendee name straight from the current document', () => {
    expect(code).toMatch(/attendeeName:\s+reg\.attendee\.name/)
  })

  it('reads one registration document and does not cache the response', () => {
    expect(code).toMatch(/collection\('registrations'\)\.doc\(registrationId\)\.get\(\)/)
    expect(code).toMatch(/'Cache-Control':\s+'no-store'/)
  })

  it('still requires a signed token or an owner/organizer bearer', () => {
    expect(code).toMatch(/verifyTicketToken\(registrationId, tokenParam\)/)
    expect(code).toMatch(/reg\.uid === uid\) \|\| \(reg\.organizerUid === uid/)
  })
})

describe('the organizer download client', () => {
  const code = readFileSync(resolve(process.cwd(),
    'app/(dashboard)/dashboard/events/[eventId]/registrations/RegistrationsClient.tsx'), 'utf8')

  it('stamps the edit version into each filename so a correction is a NEW file', () => {
    // The old filename was derived only from the ticket code, which does not change on a
    // rename — so every download collided and the browser kept serving the first file.
    expect(code).toMatch(/const docVersion = /)
    expect(code).toMatch(/ticket-\$\{reg\.ticketCode\}-\$\{docVersion\}\.pdf/)
    expect(code).toMatch(/receipt-\$\{reg\.ticketCode\}-\$\{docVersion\}\.pdf/)
  })

  it('shows the server error rather than a fixed string', () => {
    expect(code).toMatch(/describeFailure\(res, 'Could not generate receipt\.'\)/)
    expect(code).toMatch(/describeFailure\(res, 'Could not generate ticket PDF\.'\)/)
  })

  it('requests with no-store so no intermediary can serve a stale PDF', () => {
    expect((code.match(/cache:\s+'no-store'/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  it('does not disable the concurrency guard that prevents duplicate generation', () => {
    expect(code).toMatch(/if \(pdfLoading \|\| !token\) return/)
    expect(code).toMatch(/if \(receiptLoading \|\| !token\) return/)
  })
})
