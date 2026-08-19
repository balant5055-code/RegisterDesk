// RD-TICKET-PDF — "I edited the attendee's name and Download PDF still shows the old one."
//
// This test exists to settle that report with evidence rather than reasoning. It drives the
// REAL route handler twice against a mutable registration document, decompresses the produced
// PDFs, and reads the glyphs back out. Structural assertions (byte length, page count) cannot
// tell an old name from a new one, which is exactly the question.
//
// THE ANSWER IT ENCODES: the server never returns stale data. There is no persisted ticket
// artifact, no snapshot field and no cached response — the handler re-reads
// `registrations/{id}` on every request and draws `attendee.name` from it. The reported
// symptom came from the DOWNLOAD FILENAME, which was derived from the ticket code alone;
// since a rename does not change the ticket code, every download collided on one filename and
// the browser kept the first file. That is a client-side defect, and it is fixed in
// RegistrationsClient by stamping the edit version into the filename.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { pdfTextContent } from '../helpers/pdfText'

const REG_ID    = 'reg_7Kd91mQb3x'
const TICKET    = 'RD-8KD31A'
const SLUG      = 'vanathukkul-noyyal-marathon-2026'
const ORGANIZER = 'org_abc123'

type Doc = Record<string, unknown>

/** The single mutable registration document. Editing it here === the organizer's PATCH. */
let registration: Doc
/** Every read of the registration doc, so "reads the CURRENT document" is measurable. */
let docReads = 0

const freshRegistration = (): Doc => ({
  id:            REG_ID,
  eventSlug:     SLUG,
  passId:        'pass_10k',
  passName:      '10K Timed Run',
  eventName:     'VANATHUKKUL NOYYAL MARATHON',
  organizerUid:  ORGANIZER,
  uid:           'attendee_uid_1',
  attendee:      { name: 'Old Name', email: 'runner@example.com', phone: '+919840012345' },
  status:        'confirmed',
  paymentStatus: 'paid',
  amount:        150000,
  ticketCode:    TICKET,
  ticket:        { ticketId: REG_ID, qrValue: `RD:${SLUG}:${REG_ID}:${TICKET}`, qrGeneratedAt: null },
  registeredAt:  { toDate: () => new Date('2026-06-02T09:15:00Z') },
  updatedAt:     { toDate: () => new Date('2026-06-10T10:00:00Z'), toMillis: () => 1781431200000 },
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: () => ({
      doc: () => ({
        get: async () => {
          docReads += 1
          // Returns the CURRENT object every time — a stale snapshot would show up as the
          // second download still containing the old name.
          return { exists: true, data: () => registration }
        },
      }),
    }),
  },
  adminAuth: { verifyIdToken: async () => ({ uid: ORGANIZER }) },
}))

vi.mock('@/lib/firebase/firestore/events', () => ({
  getEventBySlug: async () => ({
    eventDetails: {
      info:     { name: 'VANATHUKKUL NOYYAL MARATHON' },
      schedule: { startDate: '2026-07-12', startTime: '05:30' },
      venue:    { type: 'physical', physical: { name: 'Noyyal River Park', city: 'Coimbatore' } },
      organizer:{ name: 'Vanathukkul Trust' },
    },
  }),
}))

vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '203.0.113.9' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { pdfDownload: {} },
  checkPolicy: () => ({ limited: false, retryAfter: 0 }),
}))

// Storage is doubled purely so a call would be VISIBLE. The claim under test is that a
// ticket PDF is never persisted or read back, so this must stay untouched.
const storageCalls: string[] = []
vi.mock('@/features/platform-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/platform-storage')>()
  return {
    ...actual,
    storage: {
      upload:            async () => { storageCalls.push('upload');  return { metadata: { path: 'x', size: 0 } } },
      download:          async () => { storageCalls.push('download'); throw new Error('no') },
      exists:            async () => { storageCalls.push('exists');   return false },
      generateSignedUrl: async () => { storageCalls.push('sign');     return 'https://x' },
      delete:            async () => { storageCalls.push('delete') },
    },
  }
})

import { GET } from '@/app/api/tickets/[registrationId]/pdf/route'

/** Drives the real handler exactly as the organizer's browser does (bearer auth). */
async function downloadTicketPdf(): Promise<{ res: Response; text: string; bytes: Uint8Array }> {
  const req = new NextRequest(`https://registerdesk.in/api/tickets/${REG_ID}/pdf`, {
    headers: { authorization: 'Bearer fake-organizer-id-token' },
  })
  const res = await GET(req, { params: Promise.resolve({ registrationId: REG_ID }) })
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { res, text: pdfTextContent(bytes), bytes }
}

beforeEach(() => {
  registration = freshRegistration()
  docReads = 0
  storageCalls.length = 0
})

// ─────────────────────────────────────────────────────────────────────────────
describe('editing the attendee name changes the very next PDF', () => {
  it('DOWNLOAD #1 contains the ORIGINAL name', async () => {
    const { res, text } = await downloadTicketPdf()
    expect(res.status).toBe(200)
    expect(text).toContain('Old Name')
  })

  it('DOWNLOAD #2, after the edit, contains the NEW name and not the old one', async () => {
    const first = await downloadTicketPdf()
    expect(first.text).toContain('Old Name')

    // The organizer's PATCH: attendee.name changes, updatedAt advances. Nothing else moves.
    registration.attendee = { ...(registration.attendee as Doc), name: 'New Name' }
    registration.updatedAt = { toDate: () => new Date('2026-06-11T11:00:00Z'), toMillis: () => 1781517600000 }

    const second = await downloadTicketPdf()
    expect(second.text).toContain('New Name')
    expect(second.text).not.toContain('Old Name')
  })

  it('a second edit wins again — the newest name is always the one drawn', async () => {
    registration.attendee = { ...(registration.attendee as Doc), name: 'Second Name' }
    expect((await downloadTicketPdf()).text).toContain('Second Name')
    registration.attendee = { ...(registration.attendee as Doc), name: 'Third Name' }
    const third = await downloadTicketPdf()
    expect(third.text).toContain('Third Name')
    expect(third.text).not.toContain('Second Name')
  })

  it('identity is untouched by the rename — same ticket code, same registration ID', async () => {
    const before = await downloadTicketPdf()
    registration.attendee = { ...(registration.attendee as Doc), name: 'Renamed Person' }
    const after = await downloadTicketPdf()

    expect(before.text).toContain(TICKET)
    expect(after.text).toContain(TICKET)
    expect(registration.ticketCode).toBe(TICKET)
    expect(registration.id).toBe(REG_ID)
    // The QR payload is derived from ids, never from the name.
    expect((registration.ticket as Doc).qrValue).toBe(`RD:${SLUG}:${REG_ID}:${TICKET}`)
  })
})

describe('why it cannot be stale — the mechanism, not the outcome', () => {
  it('re-reads the registration document on EVERY request', async () => {
    await downloadTicketPdf()
    expect(docReads).toBe(1)
    await downloadTicketPdf()
    expect(docReads).toBe(2)          // no memoisation between requests
  })

  it('never touches object storage — there is no persisted ticket artifact', async () => {
    await downloadTicketPdf()
    registration.attendee = { ...(registration.attendee as Doc), name: 'Another Name' }
    await downloadTicketPdf()
    expect(storageCalls).toEqual([])
  })

  it('forbids caching, so no browser or CDN may replay an old response', async () => {
    const { res } = await downloadTicketPdf()
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toBe('application/pdf')
  })

  it('two downloads of UNCHANGED data still render the current values', async () => {
    const a = await downloadTicketPdf()
    const b = await downloadTicketPdf()
    expect(a.text).toContain('Old Name')
    expect(b.text).toContain('Old Name')
  })
})

describe('the PDF carries the current event data too', () => {
  it('draws the attendee, pass and ticket code from the live document', async () => {
    const { text } = await downloadTicketPdf()
    expect(text).toContain('Old Name')
    expect(text).toContain('10K Timed Run')
    expect(text).toContain(TICKET)
  })

  it('a pass change is reflected on the next download', async () => {
    registration.passName = 'Half Marathon'
    const { text } = await downloadTicketPdf()
    expect(text).toContain('Half Marathon')
    expect(text).not.toContain('10K Timed Run')
  })
})

describe('authorization is unchanged', () => {
  it('rejects a request with no credentials at all', async () => {
    const req = new NextRequest(`https://registerdesk.in/api/tickets/${REG_ID}/pdf`)
    const res = await GET(req, { params: Promise.resolve({ registrationId: REG_ID }) })
    expect(res.status).toBe(403)
  })
})
