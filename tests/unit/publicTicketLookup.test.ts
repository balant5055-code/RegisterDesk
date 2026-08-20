// RD-TICKET-PUB-01 · the public "Download your ticket" lookup.
//
// This endpoint hands out an admission token to an unauthenticated caller, so the tests
// that matter most are the ones that try to get somebody else's.
//
// EITHER identifier is accepted. The ticket code carries the security (crypto-random,
// 29^8 combinations) while the mobile number carries the convenience. A shared number
// returns EVERY matching confirmed ticket rather than one of them — the response shape is
// a list precisely so that no code path can pick a winner. Cross-event access, the
// six-field projection and the uniform miss remain the load-bearing guarantees.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// ─── Firestore double ─────────────────────────────────────────────────────────

interface Reg {
  id: string; eventSlug: string; ticketCode: string; status: string
  eventName: string; passName: string
  attendee: { name: string; phone: string; email: string }
  organizerUid: string; uid: string; amount: number
}

let REGS: Reg[] = []

const queryOver = () => {
  const eq: Array<[string, string, unknown]> = []
  const q = {
    where(field: string, op: string, value: unknown) { eq.push([field, op, value]); return q },
    limit() { return q },
    async get() {
      const docs = REGS.filter(r => eq.every(([f, op, v]) => {
        if (f === 'eventSlug')  return r.eventSlug === v
        if (f === 'ticketCode') return r.ticketCode === v
        // `attendee.phone` is queried with an `in` over the plausible spellings. Modelling
        // it matters: without this the double returns every registration regardless of the
        // number, and the mobile-only tests would pass no matter what the route did.
        if (f === 'attendee.phone') {
          return op === 'in' && Array.isArray(v) && (v as unknown[]).includes(r.attendee.phone)
        }
        return true
      })).map(r => ({ id: r.id, data: () => r }))
      return { empty: docs.length === 0, docs }
    },
  }
  return q
}

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => ({
      ...queryOver(),
      doc: (id: string) => ({
        get: async () => {
          const r = REGS.find(x => x.id === id)
          return { exists: !!r, id, data: () => r }
        },
      }),
    }),
  },
}))

let limited = false
vi.mock('@/lib/rateLimit', () => ({ getClientIp: () => '1.2.3.4' }))
vi.mock('@/lib/rateLimit/policies', () => ({
  RATE_POLICY: { ticketLookup: { route: 'ticket-lookup', limit: 10, windowMs: 60_000 } },
  checkPolicy: () => ({ limited, retryAfter: 30 }),
}))

vi.mock('@/lib/tickets/generate', () => ({
  signTicketToken: (id: string) => `signed-${id}`,
}))

const { POST } = await import('@/app/api/events/[slug]/tickets/lookup/route')

const reg = (over: Partial<Reg> = {}): Reg => ({
  id: 'reg-alice', eventSlug: 'noyyal-marathon-2026', ticketCode: 'RD-AAAA1111',
  status: 'confirmed', eventName: 'Noyyal Marathon', passName: '10K',
  attendee: { name: 'Alice R', phone: '9916803664', email: 'alice@example.com' },
  organizerUid: 'org-1', uid: 'user-1', amount: 150000,
  ...over,
})

const call = async (slug: string, body: unknown) => {
  const res = await POST(
    new NextRequest('http://x/api/events/x/tickets/lookup', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  )
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

const SLUG = 'noyyal-marathon-2026'

/** Every success is a list now; this reads the one entry a single-match lookup returns. */
const only = (body: Record<string, unknown>) => {
  const list = body.tickets as Array<Record<string, string>> | undefined
  if (!list || list.length !== 1) throw new Error(`expected exactly 1 ticket, got ${list?.length ?? 'none'}`)
  return list[0]
}

beforeEach(() => { REGS = [reg()]; limited = false })

// ─── The happy path ───────────────────────────────────────────────────────────

describe('a valid lookup returns that attendee\'s ticket', () => {
  it('matches on ticket code + registered mobile', async () => {
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '+91 99168 03664' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    const t = only(r.body)
    expect(t.attendeeName).toBe('Alice R')
    expect(t.ticketCode).toBe('RD-AAAA1111')
  })

  it('matches on registration id too', async () => {
    const r = await call(SLUG, { ticketId: 'reg-alice', mobile: '9916803664' })
    expect(r.body.success).toBe(true)
  })

  it('accepts the ticket code in any case — attendees read it off paper', async () => {
    expect((await call(SLUG, { ticketId: 'rd-aaaa1111', mobile: '9916803664' })).body.success).toBe(true)
  })

  it('accepts any plausible spelling of the mobile number', async () => {
    // Stored AS TYPED, so the comparison must normalise rather than the data being migrated.
    for (const m of ['+91 99168 03664', '9916803664', '919916803664', '+919916803664', '99168 03664']) {
      expect((await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: m })).body.success, m).toBe(true)
    }
  })

  it('hands back the EXISTING ticket PDF route with a signed capability', async () => {
    // No second ticket renderer, and no download path that skips the identity check.
    const t = only((await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9916803664' })).body)
    expect(t.downloadUrl).toBe('/api/tickets/reg-alice/pdf?token=signed-reg-alice')
  })
})

// ─── Getting somebody else's ticket ──────────────────────────────────────────

describe('another attendee\'s ticket cannot be retrieved', () => {
  const NO_MATCH = /could not find a ticket matching those details/i

  it('right ticket code, WRONG mobile', async () => {
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9000000000' })
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
    expect(String(r.body.reason)).toMatch(NO_MATCH)
  })

  it('right mobile, WRONG ticket code', async () => {
    const r = await call(SLUG, { ticketId: 'RD-ZZZZ9999', mobile: '9916803664' })
    expect(r.status).toBe(404)
    expect(String(r.body.reason)).toMatch(NO_MATCH)
  })

  it('another attendee\'s code with your own mobile is refused', async () => {
    REGS = [reg(), reg({ id: 'reg-bob', ticketCode: 'RD-BBBB2222', attendee: { name: 'Bob', phone: '9000000001', email: 'b@x.com' } })]
    const r = await call(SLUG, { ticketId: 'RD-BBBB2222', mobile: '9916803664' })
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
  })

  it('a ticket from ANOTHER EVENT cannot be redeemed here, even with the right mobile', async () => {
    REGS = [reg({ id: 'reg-other', eventSlug: 'other-event-2026', ticketCode: 'RD-CCCC3333' })]
    const r = await call(SLUG, { ticketId: 'RD-CCCC3333', mobile: '9916803664' })
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
  })

  it('a registration ID from another event is refused — doc ids are not slug-scoped by the query', async () => {
    // The document-id path has to re-check eventSlug itself; this is that check.
    REGS = [reg({ id: 'reg-other', eventSlug: 'other-event-2026' })]
    const r = await call(SLUG, { ticketId: 'reg-other', mobile: '9916803664' })
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
  })
})

// ─── Enumeration ──────────────────────────────────────────────────────────────

describe('misses are indistinguishable from each other', () => {
  it('unknown code, wrong event and wrong mobile all return the SAME reason and status', async () => {
    REGS = [reg(), reg({ id: 'reg-far', eventSlug: 'elsewhere', ticketCode: 'RD-DDDD4444' })]
    const results = await Promise.all([
      call(SLUG, { ticketId: 'RD-NOPE0000',  mobile: '9916803664' }),   // no such code
      call(SLUG, { ticketId: 'RD-DDDD4444',  mobile: '9916803664' }),   // other event
      call(SLUG, { ticketId: 'RD-AAAA1111',  mobile: '9000000000' }),   // wrong mobile
      call(SLUG, { ticketId: 'not-an-id',    mobile: '9916803664' }),   // junk
    ])
    const reasons  = new Set(results.map(r => String(r.body.reason)))
    const statuses = new Set(results.map(r => r.status))
    expect(reasons.size, 'every miss must read identically').toBe(1)
    expect(statuses.size).toBe(1)
    expect([...statuses][0]).toBe(404)
  })

  it('a predictable/sequential guess reveals nothing', async () => {
    for (const guess of ['RD-00000001', 'RD-00000002', 'reg-1', '1', 'admin']) {
      const r = await call(SLUG, { ticketId: guess, mobile: '9916803664' })
      expect(r.body.success, guess).toBe(false)
      expect(String(r.body.reason), guess).toMatch(/could not find a ticket/i)
    }
  })
})

// ─── No sensitive data leaks ─────────────────────────────────────────────────

describe('the response exposes nothing beyond the ticket', () => {
  it('a successful lookup returns SIX fields and no contact or payment data', async () => {
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9916803664' })
    const t = only(r.body)
    expect(Object.keys(t).sort()).toEqual(
      ['attendeeName', 'downloadUrl', 'eventName', 'eventSlug', 'passName', 'ticketCode'].sort(),
    )
    const serialized = JSON.stringify(r.body)
    for (const secret of ['alice@example.com', '99168 03664', 'org-1', 'user-1', '150000']) {
      expect(serialized, secret).not.toContain(secret)
    }
  })

  it('a miss returns no registration data at all', async () => {
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9000000000' })
    expect(JSON.stringify(r.body)).not.toContain('Alice')
    expect(r.body.tickets).toBeUndefined()
  })
})

// ─── Input validation ────────────────────────────────────────────────────────

describe('missing or malformed input', () => {
  it('requires AT LEAST ONE identifier', async () => {
    for (const body of [{}, { ticketId: '  ', mobile: ' ' }, { ticketId: '' }]) {
      const r = await call(SLUG, body)
      expect(r.status, JSON.stringify(body)).toBe(400)
      expect(r.body.success).toBe(false)
    }
  })

  it('a form error does not read like an identity answer', async () => {
    const r = await call(SLUG, {})
    expect(String(r.body.reason)).toMatch(/enter your ticket id or/i)
  })

  it('non-string fields are rejected, not coerced', async () => {
    const r = await call(SLUG, { ticketId: 12345, mobile: { $ne: null } })
    expect(r.status).toBe(400)
  })
})

// ─── Status gate ──────────────────────────────────────────────────────────────

describe('only a ticketed registration yields a ticket', () => {
  for (const status of ['cancelled', 'rejected', 'pending', 'waitlisted']) {
    it(`a ${status} registration gets a clear answer, not a download`, async () => {
      REGS = [reg({ status })]
      const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9916803664' })
      expect(r.status).toBe(409)
      expect(r.body.success).toBe(false)
      // Identity was proved first, so naming the status here is help, not a leak.
      expect(r.body.found).toBe(true)
      expect(String(r.body.reason)).toContain(status)
      expect(r.body.tickets).toBeUndefined()
    })
  }

  it('the status is NOT revealed to someone who failed the identity check', async () => {
    REGS = [reg({ status: 'cancelled' })]
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9000000000' })
    expect(r.status).toBe(404)
    expect(String(r.body.reason)).not.toContain('cancelled')
  })
})

// ─── Rate limiting ────────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('a throttled caller gets 429 with Retry-After and no lookup happens', async () => {
    limited = true
    const res = await POST(
      new NextRequest('http://x/api/events/x/tickets/lookup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId: 'RD-AAAA1111', mobile: '9916803664' }),
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    )
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('30')
    expect((await res.json()).success).toBe(false)
  })

  it('the limit is tighter than the certificate lookup — a hit mints a download capability', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = (require('node:fs') as typeof import('node:fs')).readFileSync('lib/rateLimit/policies.ts', 'utf8')
    expect(src).toContain("ticketLookup:    { route: 'ticket-lookup',    limit: 10, windowMs: MIN }")
  })
})

// ─── Reuse, not reinvention ──────────────────────────────────────────────────

describe('the existing ticket infrastructure is reused', () => {
  const read = (p: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:fs') as typeof import('node:fs')).readFileSync(p, 'utf8')
  }
  const route = read('app/api/events/[slug]/tickets/lookup/route.ts')

  it('no second PDF generator was created', () => {
    expect(route).not.toContain('generateTicketPdf')
    expect(route).not.toContain('pdf-lib')
    expect(route).toContain('/pdf?token=')
  })

  it('the capability comes from the existing signer', () => {
    expect(route).toContain("from '@/lib/tickets/generate'")
    // Now inside toResult(), the single place every returned ticket is built.
    expect(route).toContain('signTicketToken(id)')
  })

  it('every registration query is scoped by the URL slug', () => {
    expect(route).toContain("where('eventSlug', '==', slug)")
    expect(route).toContain('data.eventSlug === slug')
  })

  it('the page is not indexable and fetches no attendee data server-side', () => {
    const page = read('app/events/[slug]/download-ticket/page.tsx')
    expect(page).toContain('robots: { index: false, follow: false }')
    expect(page).not.toContain("collection('registrations')")
  })
})

// ─── Either identifier alone ─────────────────────────────────────────────────

describe('a single identifier is sufficient', () => {
  it('TICKET ID alone downloads the ticket', async () => {
    // The code is crypto-random (29^8), so possession is the proof — the same property the
    // signed PDF link already relies on.
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    expect(only(r.body).attendeeName).toBe('Alice R')
  })

  it('REGISTRATION ID alone downloads the ticket', async () => {
    expect((await call(SLUG, { ticketId: 'reg-alice' })).body.success).toBe(true)
  })

  it('MOBILE alone downloads the ticket when it matches exactly one registration', async () => {
    const r = await call(SLUG, { mobile: '9916803664' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
  })

  it('mobile alone still respects event scoping', async () => {
    REGS = [reg({ id: 'reg-far', eventSlug: 'elsewhere' })]
    const r = await call(SLUG, { mobile: '9916803664' })
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
  })

  it('a wrong mobile alone is a uniform miss', async () => {
    const r = await call(SLUG, { mobile: '9000000000' })
    expect(r.status).toBe(404)
    expect(String(r.body.reason)).toMatch(/could not find a ticket/i)
  })

  it('the identifier DECIDES the registration; a mismatched mobile alongside it still refuses', async () => {
    // The strong factor picks the row; the weak one may only narrow, never redirect.
    REGS = [reg(), reg({ id: 'reg-bob', ticketCode: 'RD-BBBB2222', attendee: { name: 'Bob', phone: '9000000001', email: 'b@x.com' } })]
    const r = await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: '9000000001' })
    expect(r.status).toBe(404)
    expect(r.body.success).toBe(false)
  })
})

// ─── A shared number returns EVERY ticket, never a chosen one ────────────────

describe('one mobile, several confirmed registrations', () => {
  const family = () => [
    reg({ id: 'reg-a', ticketCode: 'RD-AAAA1111', passName: '10K', attendee: { name: 'Bala N',  phone: '9916803664',    email: 'a@x.com' } }),
    reg({ id: 'reg-b', ticketCode: 'RD-BBBB2222', passName: '5K',  attendee: { name: 'Kumar S', phone: '+919916803664', email: 'b@x.com' } }),
  ]

  it('returns ALL matching confirmed tickets', async () => {
    REGS = family()
    const r = await call(SLUG, { mobile: '9916803664' })
    expect(r.status).toBe(200)
    expect(r.body.success).toBe(true)
    const list = r.body.tickets as Array<Record<string, string>>
    expect(list).toHaveLength(2)
    expect(list.map(t => t.attendeeName).sort()).toEqual(['Bala N', 'Kumar S'])
    expect(list.map(t => t.ticketCode).sort()).toEqual(['RD-AAAA1111', 'RD-BBBB2222'])
  })

  it('each ticket carries its OWN download capability', async () => {
    // A shared capability would let one family member download another's ticket by
    // swapping the id — the token is bound to the registration it belongs to.
    REGS = family()
    const list = (await call(SLUG, { mobile: '9916803664' })).body.tickets as Array<Record<string, string>>
    const byName = Object.fromEntries(list.map(t => [t.attendeeName, t.downloadUrl]))
    expect(byName['Bala N']).toBe('/api/tickets/reg-a/pdf?token=signed-reg-a')
    expect(byName['Kumar S']).toBe('/api/tickets/reg-b/pdf?token=signed-reg-b')
    expect(new Set(list.map(t => t.downloadUrl)).size).toBe(2)
  })

  it('NO arbitrary selection — the response shape cannot express one', async () => {
    REGS = family()
    const r = await call(SLUG, { mobile: '9916803664' })
    expect(r.body.ticket).toBeUndefined()          // no single-ticket field exists
    expect(Array.isArray(r.body.tickets)).toBe(true)
  })

  it('a single match still returns a ONE-entry list, same shape', async () => {
    const r = await call(SLUG, { mobile: '9916803664' })
    expect(Array.isArray(r.body.tickets)).toBe(true)
    expect((r.body.tickets as unknown[])).toHaveLength(1)
  })

  it('excludes cancelled and pending members of the same family', async () => {
    REGS = [
      ...family(),
      reg({ id: 'reg-c', ticketCode: 'RD-CCCC3333', status: 'cancelled', attendee: { name: 'Gone',    phone: '9916803664', email: 'c@x.com' } }),
      reg({ id: 'reg-d', ticketCode: 'RD-DDDD4444', status: 'pending',   attendee: { name: 'Waiting', phone: '9916803664', email: 'd@x.com' } }),
    ]
    const list = (await call(SLUG, { mobile: '9916803664' })).body.tickets as Array<Record<string, string>>
    expect(list).toHaveLength(2)
    expect(list.map(t => t.attendeeName).sort()).toEqual(['Bala N', 'Kumar S'])
  })

  it('excludes registrations from ANOTHER EVENT sharing the number', async () => {
    REGS = [
      ...family(),
      reg({ id: 'reg-x', eventSlug: 'elsewhere', ticketCode: 'RD-XXXX9999', attendee: { name: 'Other Event', phone: '9916803664', email: 'x@x.com' } }),
    ]
    const list = (await call(SLUG, { mobile: '9916803664' })).body.tickets as Array<Record<string, string>>
    expect(list).toHaveLength(2)
    expect(list.map(t => t.attendeeName)).not.toContain('Other Event')
  })

  it('when NONE of the family is confirmed, no ticket and no names', async () => {
    REGS = [
      reg({ id: 'reg-a', status: 'cancelled', attendee: { name: 'Bala N',  phone: '9916803664',    email: 'a@x.com' } }),
      reg({ id: 'reg-b', status: 'pending',   attendee: { name: 'Kumar S', phone: '+919916803664', email: 'b@x.com' } }),
    ]
    const r = await call(SLUG, { mobile: '9916803664' })
    expect(r.status).toBe(409)
    expect(r.body.success).toBe(false)
    expect(r.body.tickets).toBeUndefined()
    expect(JSON.stringify(r.body)).not.toContain('Bala N')
  })

  it('leaks no contact data across a multi-result response', async () => {
    REGS = family()
    const body = JSON.stringify((await call(SLUG, { mobile: '9916803664' })).body)
    for (const secret of ['a@x.com', 'b@x.com', '9916803664', 'org-1', 'user-1', '150000']) {
      expect(body, secret).not.toContain(secret)
    }
  })

  it('the Ticket ID still narrows to exactly one of them', async () => {
    REGS = family()
    const r = await call(SLUG, { ticketId: 'RD-BBBB2222', mobile: '9916803664' })
    expect(only(r.body).attendeeName).toBe('Kumar S')
  })
})
// ─── The button contract the UI implements ───────────────────────────────────

describe('the form enables Find My Ticket on EITHER field', () => {
  const read = (f: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:fs') as typeof import('node:fs')).readFileSync(f, 'utf8')
  }
  const client = read('app/events/[slug]/download-ticket/DownloadTicketClient.tsx')

  it('uses OR, not AND', () => {
    expect(client).toContain('ticketId.trim().length > 0 || mobile.trim().length > 0')
    expect(client).not.toContain('ticketId.trim().length > 0 && mobile.trim().length > 0')
  })

  it('the disabled hint matches the rule', () => {
    expect(client).toContain('Enter either field to continue.')
  })

  it('renders EVERY returned ticket, each with its own download button', () => {
    expect(client).toContain('setTickets(data.tickets)')
    expect(client).toContain('tickets.map(t => (')
    expect(client).toContain('href={t.downloadUrl}')
  })

  it('heads the list honestly for one versus many', () => {
    expect(client).toContain("tickets.length === 1 ? 'Ticket found' : `Tickets found (${tickets.length})`")
  })

  it('no longer asks for a Ticket ID when a number is shared', () => {
    expect(client).not.toContain('needsId')
    expect(client).not.toContain('ambiguous')
  })
})

// ─── A known limitation of the mobile-only path ──────────────────────────────

describe('mobile-only matching is bounded by how the number was stored', () => {
  it('a number stored WITH SPACES is only found when typed the same way', async () => {
    // `attendee.phone` is stored as typed, and the mobile-only path resolves it with a
    // Firestore `in` over a handful of spellings — a query cannot normalise the stored
    // side. Internal spacing therefore survives only via the exact-input variant. This is
    // inherited from the certificate centre, and it is why the Ticket ID is offered first.
    REGS = [reg({ attendee: { name: 'Alice R', phone: '+91 99168 03664', email: 'a@x.com' } })]

    expect((await call(SLUG, { mobile: '+91 99168 03664' })).body.success).toBe(true)   // as typed
    expect((await call(SLUG, { mobile: '9916803664' })).status).toBe(404)               // normalised
  })

  it('the BOTH-fields path has no such gap — it normalises both sides', async () => {
    // phoneMatches() compares canonical forms, so the spaced storage matches any spelling
    // once the Ticket ID has already selected the row.
    REGS = [reg({ attendee: { name: 'Alice R', phone: '+91 99168 03664', email: 'a@x.com' } })]
    for (const m of ['9916803664', '+919916803664', '919916803664', '+91 99168 03664']) {
      expect((await call(SLUG, { ticketId: 'RD-AAAA1111', mobile: m })).body.success, m).toBe(true)
    }
  })
})
