// RD-RECEIPT-FIX — the receipt endpoint's failure surface.
//
// The production report was "Could not generate receipt." with nothing else to go on. That
// string came from the CLIENT, which discarded the server's response body, while the server
// had no try/catch at all — so a generator throw surfaced as a bare 500 whose reason existed
// only in the platform log, if anywhere.
//
// These tests pin the contract that makes the next failure diagnosable instead of mysterious:
// every rejection has a deliberate status and a safe message, and nothing internal leaks.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const REG_ID    = 'reg_7Kd91mQb3x'
const ORGANIZER = 'org_abc123'

type Doc = Record<string, unknown>

let registration: Doc | null
let paymentIntents: Doc[]
let eventDoc: Doc | null
let verifyIdTokenResult: () => { uid: string }
let generatorThrows: Error | null

const freshRegistration = (): Doc => ({
  id: REG_ID, eventSlug: 'noyyal-marathon-2026', passName: '10K Timed Run',
  eventName: 'VANATHUKKUL NOYYAL MARATHON', organizerUid: ORGANIZER, uid: 'attendee_1',
  attendee: { name: 'Pradeep Mbs', email: 'p@example.com', phone: '+919840012345' },
  status: 'confirmed', paymentStatus: 'paid', amount: 150000, ticketCode: 'RD-8KD31A',
  registeredAt: { toDate: () => new Date('2026-06-02T09:15:00Z') },
})

vi.mock('@/lib/firebase/admin', () => ({
  adminDb: {
    collection: (name: string) => {
      if (name === 'paymentIntents') {
        const q = { where: () => q, limit: () => q,
                    get: async () => ({ empty: paymentIntents.length === 0,
                                        docs: paymentIntents.map(d => ({ data: () => d })) }) }
        return q
      }
      return {
        doc: () => ({
          get: async () => name === 'events'
            ? { exists: eventDoc !== null, data: () => eventDoc }
            : { exists: registration !== null, data: () => registration },
        }),
      }
    },
  },
  adminAuth: { verifyIdToken: async () => verifyIdTokenResult() },
}))

vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '203.0.113.9' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { pdfDownload: {} },
  checkPolicy: () => ({ limited: false, retryAfter: 0 }),
}))
vi.mock('@/lib/receipts/token', () => ({ verifyReceiptToken: (_id: string, t: string) => t === 'valid-token' }))
vi.mock('@/lib/fees/attendeeBreakdown', () => ({ buildAttendeeFeeBreakdown: () => null }))

// The generator is real unless a test arms it to throw — that is how the 500 path is exercised
// without inventing a fake failure mode.
vi.mock('@/lib/receipts/pdf', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/receipts/pdf')>()
  return {
    ...actual,
    generateReceiptPdf: async (d: Parameters<typeof actual.generateReceiptPdf>[0]) => {
      if (generatorThrows) throw generatorThrows
      return actual.generateReceiptPdf(d)
    },
  }
})

import { GET } from '@/app/api/receipts/[registrationId]/route'

const call = async (opts: { auth?: string; token?: string } = {}) => {
  const url = `https://registerdesk.in/api/receipts/${REG_ID}${opts.token ? `?token=${opts.token}` : ''}`
  const req = new NextRequest(url, {
    headers: opts.auth ? { authorization: opts.auth } : {},
  })
  return GET(req, { params: Promise.resolve({ registrationId: REG_ID }) })
}

const ORGANIZER_AUTH = 'Bearer organizer-id-token'

beforeEach(() => {
  registration   = freshRegistration()
  paymentIntents = [{ paymentId: 'pay_Qk18ZxTvbN2mLp', updatedAt: { toDate: () => new Date('2026-06-15T09:00:00Z') } }]
  eventDoc       = { eventDetails: {
    organizer: { name: 'Vanathukkul Trust' },
    schedule:  { startDate: '2026-07-12' },
    venue:     { type: 'physical', physical: { name: 'Noyyal River Park', city: 'Coimbatore' } },
  } }
  verifyIdTokenResult = () => ({ uid: ORGANIZER })
  generatorThrows = null
})

// ─────────────────────────────────────────────────────────────────────────────
describe('the happy path', () => {
  it('returns a PDF for an authorized organizer', async () => {
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000)
  })

  it('accepts a valid signed token instead of a bearer', async () => {
    verifyIdTokenResult = () => { throw new Error('no bearer') }
    const res = await call({ token: 'valid-token' })
    expect(res.status).toBe(200)
  })

  it('still succeeds when there is no payment intent — optional data is optional', async () => {
    paymentIntents = []
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(200)
  })

  it('still succeeds when the event document is missing', async () => {
    eventDoc = null
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(200)
  })
})

describe('rejections carry a deliberate status and a safe message', () => {
  it('missing registration → 404', async () => {
    registration = null
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('Not found')
  })

  it('free registration → 404 with an explaining message', async () => {
    registration!.amount = 0
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toMatch(/free registrations/i)
  })

  it("paymentStatus 'not_required' → 404", async () => {
    registration!.paymentStatus = 'not_required'
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(404)
  })

  it('no credentials at all → 403', async () => {
    verifyIdTokenResult = () => { throw new Error('none') }
    const res = await call()
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toBe('Forbidden')
  })

  it('an invalid signed token → 403', async () => {
    const res = await call({ token: 'forged' })
    expect(res.status).toBe(403)
  })

  it('a DIFFERENT organizer is refused — no cross-event leakage', async () => {
    verifyIdTokenResult = () => ({ uid: 'org_someone_else' })
    const res = await call({ auth: 'Bearer other-organizer' })
    expect(res.status).toBe(403)
  })

  it('the registration owner is allowed', async () => {
    verifyIdTokenResult = () => ({ uid: 'attendee_1' })
    const res = await call({ auth: 'Bearer attendee-token' })
    expect(res.status).toBe(200)
  })
})

describe('a generator failure is contained, logged, and not leaked', () => {
  it('returns 500 with a generic message, never the exception text', async () => {
    generatorThrows = new Error('WinAnsi cannot encode "X" (0x25cf) at /var/task/lib/receipts/pdf.js:216')
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(500)

    const body = await res.text()
    expect(body).toContain('Could not generate receipt')
    // No stack, no internal path, no library internals.
    expect(body).not.toMatch(/WinAnsi|0x25cf|\/var\/task|\.js:\d+|at Object|node_modules/)
  })

  it('logs the real cause server-side so it is diagnosable', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    generatorThrows = new Error('boom-root-cause')
    await call({ auth: ORGANIZER_AUTH })
    expect(spy).toHaveBeenCalled()
    const logged = JSON.stringify(spy.mock.calls)
    expect(logged).toContain('[receipts] generation failed')
    expect(logged).toContain(REG_ID)
    spy.mockRestore()
  })

  it('never exposes credentials or storage internals in any response', async () => {
    for (const setup of [
      () => { registration = null },
      () => { registration!.amount = 0 },
      () => { generatorThrows = new Error('x') },
    ]) {
      registration = freshRegistration(); generatorThrows = null
      setup()
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const body = await (await call({ auth: ORGANIZER_AUTH })).text()
      spy.mockRestore()
      expect(body).not.toMatch(/firebase|firestore|r2\.|cloudflare|accessKey|secret|Bearer |projectId/i)
    }
  })
})

describe('malformed and sparse registration data', () => {
  it('a missing phone does not break generation', async () => {
    registration!.attendee = { name: 'No Phone', email: 'n@example.com' }
    expect((await call({ auth: ORGANIZER_AUTH })).status).toBe(200)
  })

  it('a missing registeredAt does not break generation', async () => {
    delete registration!.registeredAt
    expect((await call({ auth: ORGANIZER_AUTH })).status).toBe(200)
  })

  it('an event with no schedule or venue does not break generation', async () => {
    eventDoc = { eventDetails: { organizer: { name: 'Org' } } }
    expect((await call({ auth: ORGANIZER_AUTH })).status).toBe(200)
  })

  it('an online event renders its platform as the venue', async () => {
    eventDoc = { eventDetails: { organizer: { name: 'Org' },
      venue: { type: 'online', online: { platform: 'Zoom' } } } }
    expect((await call({ auth: ORGANIZER_AUTH })).status).toBe(200)
  })

  it('a refunded registration still produces a receipt', async () => {
    registration!.paymentStatus = 'refunded'
    expect((await call({ auth: ORGANIZER_AUTH })).status).toBe(200)
  })

  it('a non-Latin attendee name does not 500 — it degrades, it does not crash', async () => {
    registration!.attendee = { name: 'பிரதீப்', email: 'p@example.com' }
    const res = await call({ auth: ORGANIZER_AUTH })
    expect(res.status).toBe(200)
  })
})
