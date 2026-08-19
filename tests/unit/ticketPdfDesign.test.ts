// RD-TICKET-REDESIGN — the attendee ticket PDF, at the HTTP boundary.
//
// ═══ THE DEFECT THIS REPLACES ════════════════════════════════════════════════
// The previous layout drew every field with a bare `page.drawText(value, …)` — no maxWidth,
// no wrapping, no measurement. pdf-lib does not clip; it paints past the page edge and the
// text is silently lost. On the old 360×560pt page that was the NORMAL case, not an edge case:
//
//   • the live event's real venue — "Nallammal Temple, Mangalam (Near Tirupur Rotary West),
//     Tirupur" — ended at x=359 on a 360pt page
//   • a longer venue ended at x=555: 195pt (54%) beyond the page, entirely invisible
//   • a long pass name ended at x=441, a long attendee name at x=375
//
// The event name and header meta line used `.slice(0, 46)` / `.slice(0, 72)` — character
// counts, which have no relationship to rendered width.
//
// So these tests measure GEOMETRY, not byte counts. "The PDF generated successfully" and "the
// venue is missing from it" were both true before, and only measurement separates them.
//
// ═══ WHAT MUST NOT CHANGE ════════════════════════════════════════════════════
// The QR payload, ticket code and registration id are check-in infrastructure. The redesign
// is presentation only, and the tests below pin that: same payload, same code, no writes, no
// storage, no extra reads, unchanged authorization.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPdfGeometry, findLayoutProblems, geometryText } from '../helpers/pdfGeometry'

const REG    = 'reg_7Kd91mQb3x'
const TICKET = 'RD-AN6FWNCA'
const SLUG   = 'vanathukkul-noyyal-marathon-2026'
const ORG    = 'org_abc123'
const QR     = `RD:${SLUG}:${REG}:${TICKET}`

/** A4 with the generator's print-safe margin. */
const A4_W = 595, A4_H = 842, MARGIN = 48

type Doc = Record<string, unknown>

let registration: Doc
let eventDetails: Doc
let docReads = 0
// vi.mock factories are hoisted above ordinary consts, so anything they touch must be
// hoisted too — otherwise the factory runs before the const is initialised.
const { storageCalls, writes } = vi.hoisted(() => ({
  storageCalls: [] as string[],
  writes:       [] as string[],
}))

const freshRegistration = (o: Doc = {}): Doc => ({
  id: REG, eventSlug: SLUG, passId: 'p1', passName: '5 KM Walkathon',
  eventName: 'VANATHUKKUL NOYYAL MARATHON', organizerUid: ORG, uid: 'attendee_1',
  attendee: { name: 'Bala', email: 'bala@example.com', phone: '+919840012345' },
  status: 'confirmed', paymentStatus: 'paid', amount: 50000, ticketCode: TICKET,
  ticket: { ticketId: REG, qrValue: QR, qrGeneratedAt: null },
  registeredAt: { toDate: () => new Date('2026-06-02T09:15:00Z') },
  updatedAt: { toDate: () => new Date('2026-06-10T10:00:00Z'), toMillis: () => 1781431200000 },
  ...o,
})

const freshEvent = (o: Doc = {}): Doc => ({
  info: { name: 'VANATHUKKUL NOYYAL MARATHON' },
  schedule: { startDate: '2026-08-22', startTime: '05:00 AM' },
  venue: { type: 'physical', physical: {
    name: 'Nallammal Temple, Mangalam (Near Tirupur Rotary West)', city: 'Tirupur' } },
  organizer: { name: 'Vanathukkul Trust' },
  ...o,
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => { docReads += 1; return { exists: true, data: () => registration } },
        // Any mutation would be VISIBLE here. The claim under test is that rendering a
        // ticket writes nothing at all, so these must never be called.
        set:    async () => { writes.push('set') },
        update: async () => { writes.push('update') },
        delete: async () => { writes.push('delete') },
      }),
      add: async () => { writes.push('add') },
    }),
    runTransaction: async () => { writes.push('runTransaction') },
    batch: () => { writes.push('batch'); return {} },
  },
  adminAuth: { verifyIdToken: async () => ({ uid: ORG }) },
}))

let eventReads = 0
vi.mock('@/lib/firebase/firestore/events', () => ({
  getEventBySlug: async () => { eventReads += 1; return { eventDetails } },
}))
vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '203.0.113.9' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { pdfDownload: {} },
  checkPolicy: () => ({ limited: false, retryAfter: 0 }),
}))
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload:            async () => { storageCalls.push('upload'); return { metadata: { path: 'x', size: 0 } } },
      download:          async () => { storageCalls.push('download'); throw new Error('no') },
      exists:            async () => { storageCalls.push('exists'); return false },
      generateSignedUrl: async () => { storageCalls.push('sign'); return 'https://x' },
      delete:            async () => { storageCalls.push('delete') },
    },
  }
})

import { GET } from '@/app/api/tickets/[registrationId]/pdf/route'

async function download(opts: { auth?: string } = { auth: 'Bearer organizer-token' }) {
  const req = new NextRequest(`https://registerdesk.in/api/tickets/${REG}/pdf`, {
    headers: opts.auth ? { authorization: opts.auth } : {},
  })
  const res = await GET(req, { params: Promise.resolve({ registrationId: REG }) })
  if (res.status !== 200) return { res, geo: null, text: '' }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const geo = await readPdfGeometry(bytes)
  return { res, geo, text: geometryText(geo) }
}

beforeEach(() => {
  registration = freshRegistration()
  eventDetails = freshEvent()
  docReads = 0; eventReads = 0
  storageCalls.length = 0; writes.length = 0
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the ticket renders', () => {
  it('returns exactly one A4 portrait page', async () => {
    const { res, geo } = await download()
    expect(res.status).toBe(200)
    expect(geo!.pageCount).toBe(1)
    expect(Math.round(geo!.width)).toBe(A4_W)
    expect(Math.round(geo!.height)).toBe(A4_H)
  })

  it('carries every required field', async () => {
    const { text } = await download()
    for (const expected of [
      'Bala',                            // attendee
      '5 KM Walkathon',                  // pass
      'VANATHUKKUL NOYYAL MARATHON',     // event
      'CONFIRMED',                       // status
      TICKET,                            // ticket code
      REG,                               // registration id
    ]) expect(text).toContain(expected)
  })

  it('shows the event date, time and venue', async () => {
    const { text } = await download()
    expect(text).toContain('22 August 2026')
    expect(text).toContain('05:00 AM')
    expect(text).toContain('Nallammal Temple')
    expect(text).toContain('Tirupur')
  })

  it('carries the RegisterDesk branding and entry instruction', async () => {
    const { text } = await download()
    expect(text).toContain('REGISTERDESK')
    expect(text).toContain('EVENT TICKET')
    expect(text).toContain('KEEP THIS TICKET READY')
    expect(text).toContain('registerdesk.in')
  })
})

// ── THE REGRESSION ──────────────────────────────────────────────────────────
describe('nothing overflows, clips or overlaps', () => {
  const cases: [string, Doc, Doc][] = [
    ['normal', {}, {}],
    ['long attendee', { attendee: { name: 'Venkataraman Subrahmanyan Balasubramanian Krishnamurthy Iyer', email: 'x@y.com' } }, {}],
    ['long event', { eventName: 'The Greater Chennai Metropolitan Annual Charity Marathon and Community Wellness Festival 2026' }, {}],
    ['long venue', {}, { venue: { type: 'physical', physical: {
      name: 'Jawaharlal Nehru Indoor Stadium, Sydenhams Road, Periamet, Park Town', city: 'Chennai, Tamil Nadu 600003' } } }],
    ['long pass', { passName: 'Premium All-Access Weekend Marathon Pass With Breakfast And Finisher Medal' }, {}],
    ['unbroken token', { attendee: { name: 'A'.repeat(180), email: 'x@y.com' } }, {}],
    ['everything long', {
      attendee: { name: 'Venkataraman Subrahmanyan Balasubramanian Krishnamurthy', email: 'x@y.com' },
      passName: 'Premium All-Access Weekend Marathon Pass With Breakfast',
      eventName: 'The Greater Chennai Metropolitan Annual Charity Marathon and Wellness Festival 2026',
    }, { venue: { type: 'physical', physical: {
      name: 'Jawaharlal Nehru Indoor Stadium, Sydenhams Road, Periamet, Park Town', city: 'Chennai 600003' } } }],
  ]

  for (const [name, regOver, evtOver] of cases) {
    it(`${name}: stays inside the printable area, one page`, async () => {
      registration = freshRegistration(regOver)
      eventDetails = freshEvent(evtOver)
      const { geo } = await download()
      expect(geo!.pageCount).toBe(1)
      expect(findLayoutProblems(geo!, MARGIN)).toEqual([])
    })
  }

  it('the long venue actually WRAPS rather than being dropped', async () => {
    eventDetails = freshEvent({ venue: { type: 'physical', physical: {
      name: 'Jawaharlal Nehru Indoor Stadium, Sydenhams Road, Periamet, Park Town', city: 'Chennai, Tamil Nadu 600003' } } })
    const { geo, text } = await download()
    // Both ends of the venue string survive — the old layout lost the tail off-page.
    expect(text).toContain('Jawaharlal Nehru Indoor Stadium')
    expect(text).toContain('600003')
    expect(findLayoutProblems(geo!, MARGIN)).toEqual([])
  })

  // MUTATION: the checker must be able to fail. A guard that cannot fire proves nothing.
  it('MUTATION: the bounds checker catches an unwrapped run like the old layout produced', async () => {
    const { geo } = await download()
    const sabotaged = {
      ...geo!,
      runs: [...geo!.runs, {
        // The real measurement from the OLD ticket: venue ending at x=555 on a 360pt page.
        x: 20, y: 300, size: 11, bold: true,
        text: 'Jawaharlal Nehru Indoor Stadium, Sydenhams Road, Periamet, Park Town, Chennai',
        width: 535,
      }],
    }
    const problems = findLayoutProblems(sabotaged, MARGIN)
    expect(problems.some(p => p.kind === 'right-overflow')).toBe(true)
  })

  it('MUTATION: the checker catches overlapping text on one baseline', async () => {
    const { geo } = await download()
    const sabotaged = {
      ...geo!,
      runs: [
        { x: 48, y: 400, size: 10, bold: false, text: 'AAAA', width: 100 },
        { x: 60, y: 400, size: 10, bold: false, text: 'BBBB', width: 100 },
      ],
    }
    expect(findLayoutProblems(sabotaged, MARGIN).some(p => p.kind === 'overlap')).toBe(true)
  })
})

// ── DYNAMIC DATA ────────────────────────────────────────────────────────────
describe('the ticket always reflects the current registration', () => {
  it('an edited attendee name appears on the next download, and the old one does not', async () => {
    registration.attendee = { name: 'Old Name', email: 'x@y.com' }
    expect((await download()).text).toContain('Old Name')

    registration.attendee = { name: 'New Name', email: 'x@y.com' }
    const after = await download()
    expect(after.text).toContain('New Name')
    expect(after.text).not.toContain('Old Name')
  })

  it('renaming changes NEITHER the ticket code NOR the QR payload', async () => {
    const before = await download()
    registration.attendee = { name: 'Completely Different Person', email: 'x@y.com' }
    const after = await download()

    expect(before.text).toContain(TICKET)
    expect(after.text).toContain(TICKET)
    expect(registration.ticketCode).toBe(TICKET)
    expect((registration.ticket as Doc).qrValue).toBe(QR)
  })

  it('re-reads the registration on every request', async () => {
    await download(); expect(docReads).toBe(1)
    await download(); expect(docReads).toBe(2)
  })

  it('forbids caching', async () => {
    const { res } = await download()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })
})

// ── SPARSE DATA ─────────────────────────────────────────────────────────────
describe('missing optional data degrades cleanly', () => {
  it('no schedule and no venue still renders one clean page', async () => {
    eventDetails = freshEvent({ schedule: {}, venue: {} })
    const { geo } = await download()
    expect(geo!.pageCount).toBe(1)
    expect(findLayoutProblems(geo!, MARGIN)).toEqual([])
  })

  it('never prints N/A, undefined, null or a bare dash for an absent field', async () => {
    eventDetails = freshEvent({ schedule: {}, venue: {} })
    registration = freshRegistration({ registeredAt: undefined })
    const { text } = await download()
    expect(text).not.toMatch(/\bN\/A\b|\bundefined\b|\bnull\b/)
    expect(text).not.toMatch(/(^|\s)[-—](\s|$)/)
  })

  it('an online event renders its platform as the venue', async () => {
    eventDetails = freshEvent({ venue: { type: 'online', online: { platform: 'Zoom' } } })
    const { text } = await download()
    expect(text).toContain('Zoom')
  })

  it('a cancelled registration shows CANCELLED, not CONFIRMED', async () => {
    registration = freshRegistration({ status: 'cancelled' })
    const { text } = await download()
    expect(text).toContain('CANCELLED')
    expect(text).not.toContain('CONFIRMED')
  })

  it('a pending registration shows PENDING', async () => {
    registration = freshRegistration({ status: 'pending' })
    expect((await download()).text).toContain('PENDING')
  })

  it('a registration with no stored qrValue still renders (payload derived by the route)', async () => {
    registration = freshRegistration({ ticket: undefined })
    const { res, geo } = await download()
    expect(res.status).toBe(200)
    expect(findLayoutProblems(geo!, MARGIN)).toEqual([])
  })
})

// ── SAFETY ──────────────────────────────────────────────────────────────────
describe('the redesign introduced no new side effects', () => {
  it('performs NO Firestore write of any kind', async () => {
    await download()
    expect(writes).toEqual([])
  })

  it('performs NO object-storage call', async () => {
    await download()
    expect(storageCalls).toEqual([])
  })

  it('reads exactly one registration and one event — no unbounded query', async () => {
    await download()
    expect(docReads).toBe(1)
    expect(eventReads).toBe(1)
  })

  it('still refuses a request with no credentials', async () => {
    const res = await GET(
      new NextRequest(`https://registerdesk.in/api/tickets/${REG}/pdf`),
      { params: Promise.resolve({ registrationId: REG }) },
    )
    expect(res.status).toBe(403)
  })
})

describe('the route kept its responsibilities and gave up only the layout', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'app/api/tickets/[registrationId]/pdf/route.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('still derives the QR payload exactly as before', () => {
    expect(code).toMatch(/reg\.ticket\?\.qrValue \?\? buildQrValue\(reg\.eventSlug, registrationId, reg\.ticketCode\)/)
  })

  it('still enforces both authorization paths', () => {
    expect(code).toMatch(/verifyTicketToken\(registrationId, tokenParam\)/)
    expect(code).toMatch(/reg\.uid === uid\) \|\| \(reg\.organizerUid === uid/)
  })

  it('still reads exactly one registration document', () => {
    expect(code).toMatch(/collection\('registrations'\)\.doc\(registrationId\)\.get\(\)/)
  })

  it('no longer contains inline layout code', () => {
    expect(code).not.toMatch(/drawField|drawQrToPdf|StandardFonts|addPage/)
    expect(code).toMatch(/generateTicketPdf\(/)
  })

  it('persists nothing', () => {
    expect(code).not.toMatch(/storage\.upload|\.set\(|\.update\(|runTransaction/)
  })
})

describe('the generator cannot crash on unrenderable text', () => {
  it('every drawn string passes through the sanitiser', () => {
    const gen = readFileSync(resolve(process.cwd(), 'lib/tickets/pdf.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    // Exactly one raw drawText may exist — the one inside `write()`.
    expect((gen.match(/page\.drawText\(/g) ?? []).length).toBe(1)
  })

  it('survives non-WinAnsi input in every user-supplied field', async () => {
    registration = freshRegistration({
      attendee: { name: 'பிரதீப் 🏃', email: 'x@y.com' },
      passName: '10K – Timed “Elite”',
      eventName: 'சென்னை Marathon — 2026',
    })
    eventDetails = freshEvent({ venue: { type: 'physical', physical: { name: 'Marina · Beach', city: 'சென்னை' } } })
    const { res, geo } = await download()
    expect(res.status).toBe(200)
    expect(findLayoutProblems(geo!, MARGIN)).toEqual([])
  })
})
