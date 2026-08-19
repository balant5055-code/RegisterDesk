// RD-EVENT-DAY-CERTIFICATE-CENTER — the public lookup endpoint.
//
// This is an UNAUTHENTICATED endpoint keyed on guessable identifiers, so the tests that
// matter most are the negative ones: cross-event isolation, private-field leakage, and
// the uniformity of every miss.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const wheres: Array<[string, string, unknown]> = []
let docs: Array<Record<string, unknown>> = []
let limited = false

vi.mock('@/lib/env', () => ({ TICKET_SECRET: 'test-secret-for-lookup-tests' }))
vi.mock('@/lib/firebase/admin', () => {
  const q: Record<string, unknown> = {}
  q.where = (f: string, op: string, v: unknown) => { wheres.push([f, op, v]); return q }
  q.limit = () => q
  q.get   = async () => ({ docs: docs.map(d => ({ data: () => d })) })
  return { adminDb: { collection: () => q } }
})
vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { certificateLookup: { route: 'certificate-lookup', limit: 15, windowMs: 60000 } },
  checkPolicy: () => ({ limited, retryAfter: 30 }),
}))

import { POST } from '@/app/api/events/[slug]/certificates/lookup/route'

const SLUG = 'noyyal-marathon-2026'
const ctx  = (slug = SLUG) => ({ params: Promise.resolve({ slug }) })
const post = (body: unknown) => new NextRequest(`http://localhost/api/events/${SLUG}/certificates/lookup`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

/** A family: three participants sharing one email, in this event. */
const FAMILY = ['Bala Kumar', 'Arjun Kumar', 'Ananya Kumar'].map((attendeeName, i) => ({
  certificateId: `RDC-TEST-00${i + 1}`,
  eventSlug: SLUG, eventName: 'Noyyal Awareness Marathon 2026',
  attendeeName, attendeeEmail: 'family@example.com',
  registrationId: `reg-${i + 1}`, status: 'issued',
  // Fields that must NEVER reach the client:
  verificationToken: 'PERMANENT-TOKEN-DO-NOT-LEAK',
  organizerUid: 'org-secret', paymentId: 'pay_secret', razorpayOrderId: 'order_secret',
}))

beforeEach(() => { wheres.length = 0; docs = [...FAMILY]; limited = false })

describe('email lookup returns every participant on that email', () => {
  it('returns all three family members, not one grouped row', async () => {
    const res = await POST(post({ email: 'family@example.com' }), ctx())
    const body = await res.json() as { results: Array<{ participantName: string }> }
    expect(res.status).toBe(200)
    expect(body.results).toHaveLength(3)
    expect(body.results.map(r => r.participantName).sort())
      .toEqual(['Ananya Kumar', 'Arjun Kumar', 'Bala Kumar'])
  })

  it('normalises the email (trim + lowercase) before querying', async () => {
    await POST(post({ email: '  FAMILY@Example.COM  ' }), ctx())
    expect(wheres).toContainEqual(['attendeeEmail', '==', 'family@example.com'])
  })

  it('mints a DISTINCT capability per certificate', async () => {
    const body = await (await POST(post({ email: 'family@example.com' }), ctx())).json() as
      { results: Array<{ downloadCapability: string }> }
    const caps = body.results.map(r => r.downloadCapability)
    expect(new Set(caps).size).toBe(3)
    for (const c of caps) expect(c).toMatch(/^\d{10,16}\.[0-9a-f]{64}$/)
  })

  it('orders results stably by participant name', async () => {
    const a = await (await POST(post({ email: 'family@example.com' }), ctx())).json() as { results: Array<{ participantName: string }> }
    docs = [...FAMILY].reverse()
    const b = await (await POST(post({ email: 'family@example.com' }), ctx())).json() as { results: Array<{ participantName: string }> }
    expect(a.results.map(r => r.participantName)).toEqual(b.results.map(r => r.participantName))
  })
})

describe('event scoping — the core isolation guarantee', () => {
  it('ALWAYS filters on the slug from the URL', async () => {
    await POST(post({ email: 'family@example.com' }), ctx())
    expect(wheres).toContainEqual(['eventSlug', '==', SLUG])
  })

  it('scopes to the slug in the URL, not one supplied in the body', async () => {
    await POST(post({ email: 'family@example.com', eventSlug: 'attacker-event' }), ctx('real-event'))
    expect(wheres).toContainEqual(['eventSlug', '==', 'real-event'])
    expect(wheres.find(w => w[2] === 'attacker-event')).toBeUndefined()
  })

  it('registration-id mode is event-scoped too', async () => {
    await POST(post({ registrationId: 'reg-1' }), ctx())
    expect(wheres).toContainEqual(['eventSlug', '==', SLUG])
    expect(wheres).toContainEqual(['registrationId', '==', 'reg-1'])
  })
})

describe('no private field ever reaches the client', () => {
  it('returns exactly the five permitted keys', async () => {
    const body = await (await POST(post({ email: 'family@example.com' }), ctx())).json() as
      { results: Array<Record<string, unknown>> }
    expect(Object.keys(body.results[0]).sort()).toEqual(
      ['certificateId', 'downloadCapability', 'eventName', 'participantName', 'status'])
  })

  it('the PERMANENT verificationToken never appears anywhere in the payload', async () => {
    const raw = await (await POST(post({ email: 'family@example.com' }), ctx())).text()
    expect(raw).not.toContain('PERMANENT-TOKEN-DO-NOT-LEAK')
    expect(raw).not.toContain('verificationToken')
  })

  it('leaks no organizer, payment or contact data', async () => {
    const raw = await (await POST(post({ email: 'family@example.com' }), ctx())).text()
    for (const secret of ['org-secret', 'pay_secret', 'order_secret', 'family@example.com', 'reg-1']) {
      expect(raw, `leaked ${secret}`).not.toContain(secret)
    }
  })
})

describe('revoked certificates are omitted, indistinguishably', () => {
  it('drops a revoked certificate from the results', async () => {
    docs = [{ ...FAMILY[0], status: 'revoked' }, FAMILY[1]]
    const body = await (await POST(post({ email: 'family@example.com' }), ctx())).json() as { results: unknown[] }
    expect(body.results).toHaveLength(1)
  })

  it('an all-revoked match is byte-identical to no match at all', async () => {
    docs = [{ ...FAMILY[0], status: 'revoked' }]
    const revoked = await (await POST(post({ email: 'family@example.com' }), ctx())).text()
    docs = []
    const none = await (await POST(post({ email: 'nobody@example.com' }), ctx())).text()
    expect(revoked).toBe(none)
  })
})

describe('uniform misses defeat enumeration', () => {
  it.each([
    ['unknown email',        { email: 'nobody@example.com' }],
    ['unknown registration', { registrationId: 'does-not-exist' }],
    ['malformed email',      { email: 'not-an-email' }],
    ['over-long id',         { registrationId: 'x'.repeat(200) }],
  ])('%s returns the same empty 200', async (_l, body) => {
    docs = []
    const res = await POST(post(body), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })
})

describe('input validation', () => {
  it('rejects supplying BOTH modes rather than guessing an OR', async () => {
    const res = await POST(post({ email: 'a@b.com', registrationId: 'r1' }), ctx())
    expect(res.status).toBe(400)
  })

  it('rejects supplying neither', async () => {
    expect((await POST(post({}), ctx())).status).toBe(400)
  })

  it('rejects malformed JSON', async () => {
    const bad = new NextRequest(`http://localhost/x`, { method: 'POST', body: '{oops' })
    expect((await POST(bad, ctx())).status).toBe(400)
  })

  // RD-CERT-SEARCH-4 — mobile and bib are now supported. The V1 limitation was that
  // `attendee.phone` is stored un-normalised so a single-value query would silently miss;
  // that is solved by querying the plausible spellings in one indexed `in` filter rather
  // than by migrating live data.
  it('mobile lookup is accepted', async () => {
    const res = await POST(post({ mobile: '9876543210' }), ctx())
    expect(res.status).not.toBe(400)
  })

  it('bib lookup is accepted', async () => {
    const res = await POST(post({ bibNumber: '1042' }), ctx())
    expect(res.status).not.toBe(400)
  })

  it('still rejects more than one mode at a time', async () => {
    expect((await POST(post({ email: 'a@b.c', mobile: '9876543210' }), ctx())).status).toBe(400)
    expect((await POST(post({ mobile: '9876543210', bibNumber: '1042' }), ctx())).status).toBe(400)
  })

  it('an over-long mobile or bib falls through to the uniform empty response, not an error', async () => {
    // Same anti-oracle rule the email/registrationId shape checks already follow.
    const long = await POST(post({ mobile: '9'.repeat(40) }), ctx())
    expect(long.status).toBe(200)
    expect(await long.json()).toEqual({ results: [] })

    const bib = await POST(post({ bibNumber: 'x'.repeat(80) }), ctx())
    expect(bib.status).toBe(200)
    expect(await bib.json()).toEqual({ results: [] })
  })
})

describe('rate limiting', () => {
  it('returns 429 with Retry-After and performs no query', async () => {
    limited = true
    const res = await POST(post({ email: 'family@example.com' }), ctx())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect(wheres).toHaveLength(0)
  })
})

// ─── RD-CERT-LOOKUP-TICKET — the fifth mode ───────────────────────────────────
//
// THE DEFECT THIS PINS. `ticketCode` ("RD-XXXXXXXX") is the code on the ticket and in the
// check-in QR; `registrationId` is the Firestore document id, a uuid. They are different
// fields, and the Center previously offered only the latter — so an attendee typing the code
// they actually possess got a silent empty result that looked like "no certificate".

describe('ticket code is its own lookup mode', () => {
  it('accepts a ticket code', async () => {
    const res = await POST(post({ ticketCode: 'RD-VNT8T3UW' }), ctx())
    expect(res.status).not.toBe(400)
  })

  it('resolves it through registrations.ticketCode, event-scoped', async () => {
    await POST(post({ ticketCode: 'RD-VNT8T3UW' }), ctx())
    expect(wheres).toContainEqual(['eventSlug', '==', SLUG])
    expect(wheres).toContainEqual(['ticketCode', '==', 'RD-VNT8T3UW'])
  })

  it('upper-cases the code — tickets are minted upper-case', async () => {
    await POST(post({ ticketCode: 'rd-vnt8t3uw' }), ctx())
    expect(wheres).toContainEqual(['ticketCode', '==', 'RD-VNT8T3UW'])
  })

  it('is NOT queried as a registrationId', async () => {
    await POST(post({ ticketCode: 'RD-VNT8T3UW' }), ctx())
    expect(wheres.find(w => w[0] === 'registrationId' && w[2] === 'RD-VNT8T3UW')).toBeUndefined()
  })

  it('a registration id is still queried as a registration id', async () => {
    await POST(post({ registrationId: '6d54808e-8c45-4c9f-bd48-eb91c0f9345b' }), ctx())
    expect(wheres).toContainEqual(['registrationId', '==', '6d54808e-8c45-4c9f-bd48-eb91c0f9345b'])
    expect(wheres.find(w => w[0] === 'ticketCode')).toBeUndefined()
  })

  it('still rejects more than one mode at a time', async () => {
    expect((await POST(post({ ticketCode: 'RD-X', email: 'a@b.c' }), ctx())).status).toBe(400)
    expect((await POST(post({ ticketCode: 'RD-X', bibNumber: '12' }), ctx())).status).toBe(400)
  })

  it('an over-long code falls through to the uniform empty response', async () => {
    const res = await POST(post({ ticketCode: 'R'.repeat(80) }), ctx())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })
})

describe('bib lookup remains a two-hop registrations query', () => {
  it('queries registrations.bibNumber, event-scoped', async () => {
    await POST(post({ bibNumber: '1042' }), ctx())
    expect(wheres).toContainEqual(['eventSlug', '==', SLUG])
    expect(wheres).toContainEqual(['bibNumber', '==', '1042'])
  })
})
