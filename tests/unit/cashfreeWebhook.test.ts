// RD-PAYMENT-CASHFREE-SANDBOX-05 — the Cashfree webhook route.
//
// Every case drives the REAL route handler. The only things stubbed are Firestore (the
// intent) and the settlement function, so what is asserted is the route's own decisions:
// what it verifies, what it refuses, and — the point of the whole phase — that it never
// creates a registration itself and never moves money.
//
// The binding checks are the heart of it. A signed webhook proves Cashfree sent the message;
// it does NOT prove the message is about an order this platform is willing to settle. The
// provider, the status, the currency and the amount are each checked against the stored
// intent, which is the only authority on what should have been paid.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

const SECRET = 'TEST_SECRET'

const state = {
  intent: null as Record<string, unknown> | null,
  settleCalls: [] as Array<Record<string, unknown>>,
  outcome: { kind: 'settled', registrationId: 'reg_1' } as Record<string, unknown>,
}

vi.mock('@/lib/firebase/firestore/paymentIntents', () => ({
  getPaymentIntent: async () => state.intent,
}))
vi.mock('@/lib/payments/settleCapturedRegistration', () => ({
  settleCapturedRegistration: async (args: Record<string, unknown>) => {
    state.settleCalls.push(args)
    return state.outcome
  },
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureWebhookError: () => {}, captureFinancialError: () => {}, captureError: () => {},
}))

const INTENT = {
  orderId: 'rd_1', provider: 'cashfree', amount: 18700, currency: 'INR',
  eventSlug: 'evt', passId: 'pass-a', organizerUid: 'org-1',
  attendee: { name: 'Priya', email: 'p@example.com' }, status: 'created',
}

const sign = (ts: string, body: string, secret = SECRET) =>
  crypto.createHmac('sha256', secret).update(ts + body).digest('base64')

function successBody(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    event_time: '2026-09-27T10:00:00+05:30',
    data: {
      order:   { order_id: 'rd_1', order_amount: '187.00', order_currency: 'INR' },
      payment: {
        cf_payment_id: 555, payment_status: 'SUCCESS',
        payment_amount: '187.00', payment_currency: 'INR',
        ...over,
      },
    },
  })
}

async function post(body: string, headers: Record<string, string>) {
  const { POST } = await import('@/app/api/webhooks/cashfree/route')
  const req = new Request('http://localhost/api/webhooks/cashfree', {
    method: 'POST', headers, body,
  })
  const res = await POST(req as never)
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

const signed = (body: string, ts = '1759046400') => ({
  'x-webhook-signature': sign(ts, body),
  'x-webhook-timestamp': ts,
  'content-type': 'application/json',
})

describe('RD-PAYMENT-CASHFREE-SANDBOX-05 · webhook', () => {
  beforeEach(() => {
    vi.resetModules(); vi.unstubAllEnvs()
    vi.stubEnv('CASHFREE_SANDBOX_ENABLED', 'true')
    vi.stubEnv('CASHFREE_CLIENT_ID', 'TEST_APP_ID')
    vi.stubEnv('CASHFREE_CLIENT_SECRET', SECRET)
    vi.stubEnv('CASHFREE_ENV', 'sandbox')
    vi.stubEnv('NODE_ENV', 'test')
    state.intent = { ...INTENT }
    state.settleCalls = []
    state.outcome = { kind: 'settled', registrationId: 'reg_1' }
  })

  describe('the endpoint is off by default', () => {
    it('404s when the sandbox flag is not set', async () => {
      vi.stubEnv('CASHFREE_SANDBOX_ENABLED', '')
      const body = successBody()
      const r = await post(body, signed(body))
      // 404, not 403: an endpoint that is not part of this deployment should not advertise
      // that it exists and is merely switched off.
      expect(r.status).toBe(404)
      expect(state.settleCalls).toHaveLength(0)
    })
  })

  describe('signature verification — fail closed', () => {
    it('accepts a correctly signed success event', async () => {
      const body = successBody()
      const r = await post(body, signed(body))
      expect(r.status).toBe(200)
      expect(state.settleCalls).toHaveLength(1)
    })

    it.each([
      ['missing signature',   () => ({ 'x-webhook-timestamp': '1' })],
      ['missing timestamp',   (b: string) => ({ 'x-webhook-signature': sign('1', b) })],
      ['empty signature',     () => ({ 'x-webhook-signature': '', 'x-webhook-timestamp': '1' })],
      ['malformed signature', () => ({ 'x-webhook-signature': 'not-base64!!', 'x-webhook-timestamp': '1' })],
      ['wrong secret',        (b: string) => ({ 'x-webhook-signature': sign('1', b, 'OTHER'), 'x-webhook-timestamp': '1' })],
      ['wrong timestamp',     (b: string) => ({ 'x-webhook-signature': sign('1', b), 'x-webhook-timestamp': '2' })],
    ])('rejects: %s', async (_name, hdrs) => {
      const body = successBody()
      const r = await post(body, hdrs(body) as Record<string, string>)
      expect(r.status).toBe(400)
      expect(state.settleCalls, 'nothing may settle on a bad signature').toHaveLength(0)
    })

    it('rejects a body modified after signing', async () => {
      const body = successBody()
      const sig = signed(body)
      const tampered = body.replace('187.00', '1.00')
      const r = await post(tampered, sig)
      expect(r.status).toBe(400)
      expect(state.settleCalls).toHaveLength(0)
    })

    it('verifies BEFORE parsing — invalid JSON with a bad signature is a signature failure', async () => {
      const r = await post('not json', { 'x-webhook-signature': 'AAAA', 'x-webhook-timestamp': '1' })
      expect(r.status).toBe(400)
      expect(r.json.error).toBe('Invalid signature')
    })
  })

  describe('event filtering', () => {
    it.each(['PAYMENT_FAILED_WEBHOOK', 'PAYMENT_USER_DROPPED_WEBHOOK', 'PAYMENT_CHARGES_WEBHOOK', 'SOMETHING_ELSE'])(
      'acknowledges but does NOT settle: %s', async (type) => {
        const body = JSON.stringify({ type, data: { order: { order_id: 'rd_1' }, payment: { cf_payment_id: 1 } } })
        const r = await post(body, signed(body))
        expect(r.status).toBe(200)
        expect(state.settleCalls).toHaveLength(0)
      })

    it('refuses a success event whose payload status is NOT SUCCESS', async () => {
      // The type alone is not proof — the payload carries its own status and the two must agree.
      const body = successBody({ payment_status: 'PENDING' })
      const r = await post(body, signed(body))
      expect(r.status).toBe(200)
      expect(r.json.ignored).toBe('payment_not_successful')
      expect(state.settleCalls).toHaveLength(0)
    })
  })

  describe('binding checks — a signature is not authorisation to settle', () => {
    it('unknown order is acknowledged, never settled', async () => {
      state.intent = null
      const body = successBody()
      const r = await post(body, signed(body))
      expect(r.status).toBe(200)
      expect(r.json.ignored).toBe('unknown_order')
      expect(state.settleCalls).toHaveLength(0)
    })

    it('PROVIDER mismatch is refused — a Cashfree event may not settle a Razorpay intent', async () => {
      state.intent = { ...INTENT, provider: 'razorpay' }
      const body = successBody()
      const r = await post(body, signed(body))
      expect(r.status).toBe(409)
      expect(state.settleCalls).toHaveLength(0)
    })

    it('AMOUNT mismatch is refused', async () => {
      const body = successBody({ payment_amount: '1.00' })
      const r = await post(body, signed(body))
      expect(r.status).toBe(409)
      expect(state.settleCalls).toHaveLength(0)
    })

    it('CURRENCY mismatch is refused', async () => {
      const body = successBody({ payment_currency: 'USD' })
      const r = await post(body, signed(body))
      expect(r.status).toBe(409)
      expect(state.settleCalls).toHaveLength(0)
    })

    it('an unparseable amount is refused rather than coerced', async () => {
      const body = successBody({ payment_amount: 'abc' })
      const r = await post(body, signed(body))
      expect(r.status).toBe(400)
      expect(state.settleCalls).toHaveLength(0)
    })

    it('compares the DECIMAL amount exactly — 187.00 matches 18700 paise', async () => {
      // The whole float hazard in one assertion: the wire form is decimal rupees and the
      // intent is integer paise, and they must compare equal without a rounding step.
      const body = successBody({ payment_amount: '187.00' })
      await post(body, signed(body))
      expect(state.settleCalls).toHaveLength(1)
    })

    it('missing identifiers are refused', async () => {
      const body = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: {}, payment: {} } })
      const r = await post(body, signed(body))
      expect(r.status).toBe(400)
      expect(state.settleCalls).toHaveLength(0)
    })
  })

  describe('settlement boundary', () => {
    it('delegates to the SHARED settlement — it never creates a registration itself', async () => {
      const body = successBody()
      await post(body, signed(body))
      expect(state.settleCalls[0]).toMatchObject({
        orderId: 'rd_1', paymentId: '555', source: 'webhook',
      })
    })

    it('a duplicate delivery settles once — idempotency belongs to the settlement', async () => {
      const body = successBody()
      await post(body, signed(body))
      state.outcome = { kind: 'already_settled', registrationId: 'reg_1' }
      const second = await post(body, signed(body))
      expect(second.status).toBe(200)
      // Both calls reach settlement; settlement returns already_settled on the replay. There
      // is deliberately no second dedupe table here, which would be a second thing that can
      // disagree with the first.
      expect(state.settleCalls).toHaveLength(2)
      expect(state.settleCalls.every(c => c.orderId === 'rd_1')).toBe(true)
    })

    it('a HELD outcome is acknowledged and nothing is refunded', async () => {
      state.outcome = { kind: 'held', reason: 'EVENT_CAPACITY_FULL' }
      const body = successBody()
      const r = await post(body, signed(body))
      expect(r.status).toBe(200)
    })

    it('the route has no way to issue a refund', async () => {
      const { readFileSync } = await import('node:fs')
      const src = readFileSync('app/api/webhooks/cashfree/route.ts', 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      // A CALL, not the word. The route legitimately says "NOT refunded" in the message it
      // logs when a payment is held — asserting on the word would fail on the sentence that
      // documents the guarantee.
      expect(src).not.toMatch(/\.refund\s*\(/)
      expect(src).not.toMatch(/resolveRefundProvider/)
      expect(src).not.toMatch(/payments\.refund/)
    })
  })
})
