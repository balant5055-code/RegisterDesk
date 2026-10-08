// RD-COMMS-P2-D — email send outcomes are DEFINITE or UNKNOWN, and an unknown one is never resent.
//
//   • SES / Resend: a provider ANSWER (< 500) is a definite rejection; a timeout, a dropped
//     connection or a 5xx is `deliveryUnknown` (the provider may already have accepted it);
//   • the notification engine retries only definite rejections — never an unknown or suppressed one;
//   • a suppressed recipient is still blocked at the provider gate (default SES, explicit Resend);
//   • the registration confirmation records an unknown outcome on its log, and the manual retry
//     route refuses to resend such a log and never strands a row in 'queued'.
// The broadcast email job's interrupted / unknown handling is proven on the emulator
// (tests/emulator/emailReliabilityP2D.emu.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ suppressed: false, results: [] as Array<Record<string, unknown>>, calls: 0 }))

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('@/lib/firebase/firestore/emailSuppressionList', () => ({ isSuppressed: async () => h.suppressed }))
vi.mock('@/lib/communications/resolveCommunicationConfig', () => ({
  getCommunicationConfig: async () => ({ email: { enabled: true }, whatsapp: { enabled: false } }),
}))
// The engine's provider: every dispatcher method returns the next scripted result.
vi.mock('@/lib/notifications/providerResolver', () => ({
  resolveProvider: () => new Proxy({}, { get: () => async () => { h.calls++; return h.results.shift() ?? { success: true } } }),
}))

const read = (f: string) => readFileSync(f, 'utf8')
const { SESProvider } = await import('@/lib/email/ses')
const { ResendProvider } = await import('@/lib/email/resend')
const { notificationEngine, NotificationType } = await import('@/lib/notifications')

const ses = (send: () => Promise<unknown>) => new SESProvider({ send } as never, 'no-reply@registerdesk.test', 'RegisterDesk')
const resend = (send: () => Promise<unknown>) => new ResendProvider({ emails: { send } } as never, 'no-reply@registerdesk.test', 'RegisterDesk')
const awsError = (name: string, httpStatusCode?: number) => Object.assign(new Error(name), { name, ...(httpStatusCode ? { $metadata: { httpStatusCode } } : {}) })

beforeEach(() => { h.suppressed = false; h.results = []; h.calls = 0 })

describe('SES (the default provider) — definite vs unknown', () => {
  it('accepted ⇒ success with the message id', async () => {
    expect(await ses(async () => ({ MessageId: 'm-1' })).send('a@x.test', 'S', '<p>x</p>')).toEqual({ success: true, messageId: 'm-1' })
  })
  it('a timeout / abort / network error (no HTTP status) ⇒ deliveryUnknown', async () => {
    for (const e of [awsError('TimeoutError'), awsError('AbortError'), awsError('ECONNRESET')]) {
      const r = await ses(async () => { throw e }).send('a@x.test', 'S', '<p>x</p>')
      expect(r, e.name).toMatchObject({ success: false, deliveryUnknown: true })
    }
  })
  it('a 5xx ⇒ deliveryUnknown; a 4xx answer ⇒ a DEFINITE rejection (no flag)', async () => {
    expect(await ses(async () => { throw awsError('InternalFailure', 500) }).send('a@x.test', 'S', 'x')).toMatchObject({ success: false, deliveryUnknown: true })
    const rejected = await ses(async () => { throw awsError('MessageRejected', 400) }).send('a@x.test', 'S', 'x')
    expect(rejected.success).toBe(false)
    expect(rejected.deliveryUnknown).toBeUndefined()
  })
  it('a suppressed recipient is not sent at all', async () => {
    h.suppressed = true
    const send = vi.fn(async () => ({ MessageId: 'm' }))
    expect(await ses(send).send('dead@x.test', 'S', 'x')).toMatchObject({ success: false, suppressed: true })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('Resend (explicit per-event provider) — definite vs unknown', () => {
  it('accepted ⇒ success', async () => {
    expect(await resend(async () => ({ data: { id: 'r-1' }, error: null })).send('a@x.test', 'S', 'x')).toEqual({ success: true, messageId: 'r-1' })
  })
  it('an API answer < 500 ⇒ definite; a 5xx answer or a throw/timeout ⇒ deliveryUnknown', async () => {
    const definite = await resend(async () => ({ data: null, error: { name: 'validation_error', message: 'bad', statusCode: 422 } })).send('a@x.test', 'S', 'x')
    expect(definite.success).toBe(false)
    expect(definite.deliveryUnknown).toBeUndefined()
    expect(await resend(async () => ({ data: null, error: { name: 'internal_server_error', message: 'x', statusCode: 500 } })).send('a@x.test', 'S', 'x')).toMatchObject({ deliveryUnknown: true })
    expect(await resend(async () => { throw new Error('Resend request timeout') }).send('a@x.test', 'S', 'x')).toMatchObject({ success: false, deliveryUnknown: true })
  })
  it('a suppressed recipient is not sent at all', async () => {
    h.suppressed = true
    const send = vi.fn(async () => ({ data: { id: 'r' }, error: null }))
    expect(await resend(send).send('dead@x.test', 'S', 'x')).toMatchObject({ suppressed: true })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('notification engine — only a DEFINITE rejection is retried', () => {
  const send = () => notificationEngine.send(NotificationType.REGISTRATION_CONFIRMATION, { to: 'a@x.test' } as never, 'ses')
  it('a definite rejection of a transactional email is retried (bounded)', async () => {
    h.results = [{ success: false, error: 'rejected' }, { success: false, error: 'rejected' }, { success: true, messageId: 'ok' }]
    expect(await send()).toMatchObject({ success: true })
    expect(h.calls).toBe(3)
  })
  it('an UNKNOWN outcome is final — never resent', async () => {
    h.results = [{ success: false, error: 'timeout', deliveryUnknown: true }, { success: true }]
    expect(await send()).toMatchObject({ success: false, deliveryUnknown: true })
    expect(h.calls).toBe(1)
  })
  it('a suppressed recipient is final', async () => {
    h.results = [{ success: false, suppressed: true }, { success: true }]
    expect(await send()).toMatchObject({ suppressed: true })
    expect(h.calls).toBe(1)
  })
})

describe('transactional paths record an unknown outcome; the manual retry never resends it', () => {
  it('the registration confirmation writes deliveryUnknown to its log', () => {
    const src = read('lib/registrations/sendConfirmationEmail.ts')
    expect(src).toContain('emailDeliveryUnknown = result.deliveryUnknown === true')
    expect(src).toContain('...(emailDeliveryUnknown ? { deliveryUnknown: true } : {}),')
  })
  it('the retry route refuses a delivery-unknown log, records a new unknown, and never strands a claim', () => {
    const src = read('app/api/organizer/email-logs/[logId]/retry/route.ts')
    expect(src).toMatch(/deliveryUnknown === true\) \{\s*return \{ ok: false as const, status: 409/)
    expect(src).toContain('...(deliveryUnknown ? { deliveryUnknown: true } : {}),')
    // every unexpected error after the claim releases it back to 'failed'
    expect(src).toMatch(/try \{\s*return await resend\(logId, log\)\s*\} catch \(err\) \{[\s\S]{0,200}updateEmailLog\(logId, 'failed'/)
  })
  it('email never touches the communication balance or WhatsApp capacity (billing is WhatsApp/SMS-only)', () => {
    const billing = read('lib/communications/billing.ts')
    expect(billing).toMatch(/: args\.channel === 'sms'\s+\? comm\.sms\.pricePaise\s+: 0/)
    for (const f of ['lib/broadcasts/emailJob.ts', 'lib/registrations/sendConfirmationEmail.ts', 'lib/email/ses.ts', 'lib/email/resend.ts', 'lib/notifications/engine.ts']) {
      expect(read(f), f).not.toMatch(/organizerWallets|eventServiceAllowances|reserveWhatsAppFunding|reserveServiceUnits/)
    }
  })
})
