// MSG91 registration-confirmation SMS.
//
// SMS is ADDITIVE: it is fired fire-and-forget after the confirmation email, from the one
// point where a successful registration is already established. These tests hold the two
// properties that matter most — the registration/payment record is never touched by an SMS
// outcome, and the four converging paths (submit, verify-payment, webhook, reconciliation)
// cannot produce more than one message.
//
// MSG91 is mocked at the fetch boundary. No real SMS is ever sent.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Env: credentials present. Values are fake and asserted never to leak. ────
const { AUTH_KEY } = vi.hoisted(() => ({ AUTH_KEY: 'TEST-AUTH-KEY-SHOULD-NEVER-BE-LOGGED' }))
vi.mock('@/lib/env', () => ({
  MSG91_AUTH_KEY:    AUTH_KEY,
  MSG91_SENDER_ID:   'RGDESK',
  MSG91_TEMPLATE_ID: 'TPL-DLT-APPROVED-123',
}))

// ── Firestore: capture every patch so we can prove what SMS does and does not write ──
const updates: Record<string, unknown>[] = []
let regDoc: Record<string, unknown> | null = null
let claimShouldFail = false

vi.mock('@/lib/firebase/admin', () => {
  const docApi = {
    get:    async () => ({ exists: regDoc !== null, data: () => regDoc }),
    update: async (p: Record<string, unknown>) => { updates.push(p) },
  }
  return {
    adminDb: {
      collection: () => ({ doc: () => docApi }),
      runTransaction: async (fn: (tx: unknown) => Promise<boolean>) => {
        if (claimShouldFail) throw new Error('txn failed')
        return fn({
          get:    async () => ({ exists: regDoc !== null, data: () => regDoc }),
          update: (_ref: unknown, p: Record<string, unknown>) => { updates.push(p) },
        })
      },
    },
  }
})

const logs: Record<string, unknown>[] = []
vi.mock('@/lib/email-logs/write', () => ({ writeEmailLog: async (r: Record<string, unknown>) => { logs.push(r) } }))

import { sendRegistrationSms } from '@/lib/registrations/sendRegistrationSms'

// ── MSG91 transport double ───────────────────────────────────────────────────
interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }
const calls: Call[] = []
let respond: () => Promise<Response> = async () =>
  new Response(JSON.stringify({ type: 'success', request_id: 'req-1' }), { status: 200 })

beforeEach(() => {
  updates.length = 0; logs.length = 0; calls.length = 0
  claimShouldFail = false
  regDoc = { attendee: { phone: '9876543210' }, status: 'confirmed', paymentStatus: 'paid' }
  respond = async () => new Response(JSON.stringify({ type: 'success', request_id: 'req-1' }), { status: 200 })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    })
    return respond()
  })
})

const ARGS = {
  registrationId: 'reg-1', organizerUid: 'org-1', eventSlug: 'noyyal-marathon-2026',
  eventName: 'Noyyal Marathon 2026', attendeeName: 'Bala', attendeeEmail: 'a@example.com',
  ticketUrl: 'https://registerdesk.in/tickets/reg-1',
}
const recipient = () => (calls[0].body.recipients as Record<string, string>[])[0]

describe('1-4 · a confirmed registration sends one correctly-addressed SMS', () => {
  it('calls MSG91 with the configured DLT template and sender', async () => {
    expect(await sendRegistrationSms(ARGS)).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('control.msg91.com/api/v5/flow')
    expect(calls[0].body.template_id).toBe('TPL-DLT-APPROVED-123')
    expect(calls[0].body.sender).toBe('RGDESK')
  })

  it('addresses the attendee and passes the registration variables', async () => {
    await sendRegistrationSms(ARGS)
    const r = recipient()
    expect(r.mobiles).toBe('919876543210')
    expect(r.name).toBe('Bala')
    expect(r.event).toBe('Noyyal Marathon 2026')
    expect(r.regid).toBe('reg-1')
    expect(r.url).toBe('https://registerdesk.in/tickets/reg-1')
  })

  it('records success on the registration and in the communication log', async () => {
    await sendRegistrationSms(ARGS)
    expect(updates.some(u => u.smsStatus === 'sent')).toBe(true)
    const log = logs[0]
    expect(log.channel).toBe('sms')
    expect(log.provider).toBe('msg91')
    expect(log.status).toBe('sent')
    expect(log.registrationId).toBe('reg-1')
    expect(log.eventSlug).toBe('noyyal-marathon-2026')
    expect(log.providerMessageId).toBe('req-1')
  })
})

describe('11-12 · phone normalisation', () => {
  it.each([
    ['9876543210',    '919876543210'],
    ['919876543210',  '919876543210'],
    ['+919876543210', '919876543210'],
    ['+91 98765 43210', '919876543210'],
    ['09876543210',   '919876543210'],
  ])('%s → %s (never double-prefixed)', async (input, expected) => {
    regDoc = { attendee: { phone: input } }
    await sendRegistrationSms(ARGS)
    expect(recipient().mobiles).toBe(expected)
    expect(recipient().mobiles).not.toMatch(/^9191/)
  })
})

describe('10 · missing or invalid phone skips safely', () => {
  it.each([undefined, '', '   ', '12'])('phone %j → skipped, no MSG91 call', async (phone) => {
    regDoc = { attendee: { phone } }
    expect(await sendRegistrationSms(ARGS)).toBe('skipped_no_phone')
    expect(calls).toHaveLength(0)
    expect(updates.some(u => u.smsStatus === 'skipped_no_phone')).toBe(true)
  })
})

describe('6-9 · failures never touch registration or payment state', () => {
  const assertStateUntouched = () => {
    for (const u of updates) {
      for (const k of ['status', 'paymentStatus', 'amount', 'amountPaid', 'paymentId', 'refundId', 'registrationId']) {
        expect(u, `SMS wrote ${k}`).not.toHaveProperty(k)
      }
      // Only sms* fields are ever written.
      for (const k of Object.keys(u)) expect(k.startsWith('sms')).toBe(true)
    }
  }

  it('a provider 500 records failure and leaves state untouched', async () => {
    respond = async () => new Response('upstream boom', { status: 500 })
    expect(await sendRegistrationSms(ARGS)).toBe('failed')
    expect(updates.some(u => u.smsStatus === 'failed')).toBe(true)
    assertStateUntouched()
  })

  it('a timeout records failure and leaves state untouched', async () => {
    respond = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) }
    expect(await sendRegistrationSms(ARGS)).toBe('failed')
    assertStateUntouched()
  })

  it('a 200 body of {type:"error"} is treated as a rejection, not a success', async () => {
    respond = async () => new Response(JSON.stringify({ type: 'error', message: 'invalid template' }), { status: 200 })
    expect(await sendRegistrationSms(ARGS)).toBe('failed')
    expect(logs[0].status).toBe('failed')
  })

  it('the sender never throws, even when Firestore itself misbehaves', async () => {
    claimShouldFail = true
    await expect(sendRegistrationSms(ARGS)).resolves.toBeDefined()
  })
})

describe('8-9 · retry classification is bounded', () => {
  it.each([
    [429, 'transient'],
    [503, 'transient'],
    [500, 'transient'],
    [400, 'permanent'],
    [401, 'permanent'],
    [422, 'permanent'],
  ])('HTTP %i is %s', async (status, kind) => {
    const { sendMsg91Sms } = await import('@/lib/sms/msg91')
    respond = async () => new Response('x', { status })
    const r = await sendMsg91Sms('919876543210', {})
    expect(r.success).toBe(false)
    expect(r.failure).toBe(kind)   // permanent ⇒ the caller must not retry forever
  })
})

describe('13 · converging paths do not duplicate the SMS', () => {
  it('a second call after a successful send does not call MSG91 again', async () => {
    expect(await sendRegistrationSms(ARGS)).toBe('sent')
    expect(calls).toHaveLength(1)

    // verify-payment / webhook / reconciliation replay: smsStatus is now terminal.
    regDoc = { ...regDoc, smsStatus: 'sent' }
    expect(await sendRegistrationSms(ARGS)).toBe('sent')
    expect(calls).toHaveLength(1)      // still ONE message
  })

  it('an explicit operator resend bypasses the guard', async () => {
    regDoc = { ...regDoc, smsStatus: 'sent' }
    await sendRegistrationSms(ARGS, { force: true })
    expect(calls).toHaveLength(1)
  })

  it('a previous FAILURE may be retried — only "sent" is terminal', async () => {
    regDoc = { ...regDoc, smsStatus: 'failed' }
    expect(await sendRegistrationSms(ARGS)).toBe('sent')
    expect(calls).toHaveLength(1)
  })
})

describe('14-15 · no fallback, no secret leakage', () => {
  it('sends only to MSG91 — never any email/SES transport', async () => {
    respond = async () => new Response('nope', { status: 500 })
    await sendRegistrationSms(ARGS)
    expect(calls.every(c => c.url.includes('msg91.com'))).toBe(true)
    // A failed SMS produces no substitute message on another channel.
    expect(logs.filter(l => l.channel !== 'sms')).toHaveLength(0)
  })

  it('the auth key travels in a header and never reaches a log, body or error', async () => {
    respond = async () => new Response(JSON.stringify({ type: 'error', message: 'bad' }), { status: 200 })
    await sendRegistrationSms(ARGS)
    expect(calls[0].headers.authkey).toBe(AUTH_KEY)          // header only
    expect(JSON.stringify(calls[0].body)).not.toContain(AUTH_KEY)
    expect(JSON.stringify(logs)).not.toContain(AUTH_KEY)
    expect(JSON.stringify(updates)).not.toContain(AUTH_KEY)
  })
})

describe('unconfigured deployment behaves exactly as before SMS existed', () => {
  it('writes nothing and calls nothing when credentials are absent', async () => {
    vi.resetModules()
    vi.doMock('@/lib/env', () => ({ MSG91_AUTH_KEY: '', MSG91_SENDER_ID: '', MSG91_TEMPLATE_ID: '' }))
    const { sendRegistrationSms: send } = await import('@/lib/registrations/sendRegistrationSms')
    expect(await send(ARGS)).toBe('skipped_not_configured')
    expect(calls).toHaveLength(0)
    expect(updates).toHaveLength(0)
    expect(logs).toHaveLength(0)
    vi.doUnmock('@/lib/env')
    vi.resetModules()
  })
})
