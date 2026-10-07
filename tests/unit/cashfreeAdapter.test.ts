// RD-PAYMENT-CASHFREE-SANDBOX-05 — the Cashfree adapter against its verified REST contract.
//
// Cashfree is stubbed at `fetch`, so these cases pin the request RegisterDesk sends and the
// normalization of what comes back. Nothing here reaches a network.
//
// ═══ WHAT MATTERS MOST HERE IS THE MONEY ═════════════════════════════════════
// Razorpay speaks integer paise; Cashfree speaks decimal rupees, and its own docs warn that
// `170.00` must not be read as `170`. RegisterDesk stores integer paise and compares them
// exactly, so every conversion has to be lossless in both directions. The float trap —
// `18699 / 100 * 100` → 18698.999999999996 — would produce a one-paise mismatch that only
// surfaces as a rejected payment or a reconciliation discrepancy weeks later. It is
// asserted directly.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import nodeCrypto from 'crypto'
import {
  paiseToRupeeString, rupeesToPaise, mapCashfreeStatus, toNormalizedPayment,
  verifyCashfreeWebhook, CASHFREE_API_VERSION, CASHFREE_SANDBOX_BASE,
} from '@/lib/payments/providers/cashfreeAdapter'

const ENV = {
  CASHFREE_CLIENT_ID: 'TEST_APP_ID',
  CASHFREE_CLIENT_SECRET: 'TEST_SECRET',
  CASHFREE_ENV: 'sandbox',
}

function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }))
  vi.stubGlobal('fetch', spy)
  return spy
}

async function adapter() {
  const { cashfreeAdapter } = await import('@/lib/payments/providers/cashfreeAdapter')
  return cashfreeAdapter
}

describe('RD-PAYMENT-CASHFREE-SANDBOX-05 · money conversion', () => {
  it('paise → decimal rupees, exactly', () => {
    expect(paiseToRupeeString(18700)).toBe('187.00')
    expect(paiseToRupeeString(18699)).toBe('186.99')
    expect(paiseToRupeeString(100)).toBe('1.00')
    expect(paiseToRupeeString(5)).toBe('0.05')
    expect(paiseToRupeeString(0)).toBe('0.00')
  })

  it('rejects a non-integer amount rather than silently rounding it', () => {
    expect(() => paiseToRupeeString(186.995)).toThrow(/integer paise/)
  })

  it('decimal rupees → paise, from the TEXT form', () => {
    expect(rupeesToPaise('187.00')).toBe(18700)
    expect(rupeesToPaise('186.99')).toBe(18699)
    expect(rupeesToPaise('0.05')).toBe(5)
    expect(rupeesToPaise(187)).toBe(18700)      // JSON.parse will have made it a number
    expect(rupeesToPaise('187')).toBe(18700)
    expect(rupeesToPaise('187.1')).toBe(18710)  // one decimal place is still valid
  })

  it('round-trips every amount losslessly — the float trap', () => {
    // 18699 is the classic: 18699/100*100 === 18698.999999999996 in IEEE-754.
    for (const paise of [1, 5, 99, 100, 18699, 18700, 99999, 123456789]) {
      expect(rupeesToPaise(paiseToRupeeString(paise)), `round trip failed for ${paise}`).toBe(paise)
    }
  })

  it('refuses an unparseable amount instead of returning NaN', () => {
    for (const bad of ['', 'abc', '1.2.3', '₹187']) {
      expect(() => rupeesToPaise(bad)).toThrow(/unparseable/)
    }
  })
})

describe('RD-PAYMENT-CASHFREE-SANDBOX-05 · status normalization', () => {
  it('ONLY SUCCESS is captured', () => {
    expect(mapCashfreeStatus('SUCCESS')).toBe('captured')
  })

  it('every other documented status is not a capture', () => {
    for (const s of ['FAILED', 'USER_DROPPED', 'VOID', 'CANCELLED']) {
      expect(mapCashfreeStatus(s), s).toBe('failed')
    }
    // RD-PAYMENT-CASHFREE-CHECKOUT-06 — PENDING and NOT_ATTEMPTED are no longer the same
    // thing. A real sandbox UPI collect sits at PENDING for ~30s and then SUCCEEDS, so
    // folding it into `created` told payment-status "nobody has paid" about a payment that
    // was about to land — and that answer releases the form for a second charge.
    expect(mapCashfreeStatus('PENDING')).toBe('pending')
    expect(mapCashfreeStatus('NOT_ATTEMPTED')).toBe('created')
  })

  it('PENDING is neither success nor failure', () => {
    // The two mistakes that matter, asserted in both directions.
    expect(mapCashfreeStatus('PENDING')).not.toBe('captured')
    expect(mapCashfreeStatus('PENDING')).not.toBe('failed')
  })

  it('an UNKNOWN status reads as failed — never as captured', () => {
    // The safe direction. Reading an unrecognised status as success would settle a
    // registration against money nobody has.
    for (const s of ['SOMETHING_NEW', '', null, undefined, 42]) {
      expect(mapCashfreeStatus(s)).toBe('failed')
    }
  })

  it('normalizes a payment without leaking Cashfree field names', () => {
    const p = toNormalizedPayment({
      cf_payment_id: 1234567, order_id: 'rd_1', payment_status: 'SUCCESS',
      payment_amount: '187.00', payment_currency: 'INR', payment_time: '2026-09-27T10:00:00+05:30',
    })
    expect(p).toMatchObject({
      provider: 'cashfree', providerPaymentId: '1234567', providerOrderId: 'rd_1',
      status: 'captured', amountPaise: 18700, currency: 'INR',
    })
    expect(p.capturedAtMs).toBe(Date.parse('2026-09-27T10:00:00+05:30'))
  })

  it('a non-captured payment carries no capture time', () => {
    const p = toNormalizedPayment({ cf_payment_id: 1, payment_status: 'FAILED', payment_amount: '1.00', payment_time: '2026-09-27T10:00:00Z' })
    expect(p.capturedAtMs).toBeNull()
  })
})

describe('RD-PAYMENT-CASHFREE-SANDBOX-05 · adapter operations', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v) })

  it('createOrder posts the verified contract to the SANDBOX base', async () => {
    const f = stubFetch(200, { order_id: 'rd_1', cf_order_id: 'cf_1', payment_session_id: 'sess_1' })
    const order = await (await adapter()).createOrder({
      amountPaise: 18700, currency: 'INR', receipt: 'rd_1',
      customer: { id: 'cust_1', phone: '9876543210', email: 'a@b.com', name: 'Priya' },
    })

    // RD-PAYMENT-CASHFREE-CHECKOUT-06 — the payment session is now CARRIED. It was parsed
    // and dropped before, which left a Cashfree order that no browser could ever pay.
    expect(order).toEqual({
      provider: 'cashfree', providerOrderId: 'rd_1', amountPaise: 18700, currency: 'INR',
      // `mode` is the SERVER's environment, carried so the browser instantiates the matching
      // Cashfree SDK. ENV is stubbed to sandbox for this suite.
      checkout: { provider: 'cashfree', paymentSessionId: 'sess_1', mode: 'sandbox' },
    })

    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe(`${CASHFREE_SANDBOX_BASE}/orders`)
    expect(init.headers['x-api-version']).toBe(CASHFREE_API_VERSION)
    expect(init.headers['x-client-id']).toBe('TEST_APP_ID')
    expect(init.headers['x-client-secret']).toBe('TEST_SECRET')
    // The amount leaves as a decimal STRING, never a float.
    expect(JSON.parse(init.body)).toMatchObject({
      order_id: 'rd_1', order_amount: '187.00', order_currency: 'INR',
      customer_details: { customer_id: 'cust_1', customer_phone: '9876543210' },
    })
  })

  it('createOrder FAILS CLOSED without customer details rather than inventing a phone', async () => {
    // Cashfree requires customer_details; RegisterDesk allows attendees with no phone. A
    // placeholder would send a real payment receipt toward a number nobody owns.
    stubFetch(200, {})
    await expect((await adapter()).createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'rd_2',
    })).rejects.toThrow(/customer_details/)
  })

  it('refuses to run outside the sandbox', async () => {
    vi.stubEnv('CASHFREE_ENV', 'production')
    stubFetch(200, {})
    await expect((await adapter()).createOrder({
      amountPaise: 100, currency: 'INR', receipt: 'r',
      customer: { id: 'c', phone: '9876543210' },
    })).rejects.toThrow(/sandbox/)
  })

  it('refuses when credentials are absent', async () => {
    vi.stubEnv('CASHFREE_CLIENT_ID', '')
    stubFetch(200, {})
    await expect((await adapter()).fetchOrderPayments('rd_1')).rejects.toThrow(/not configured/)
  })

  it('fetchOrderPayments normalizes a list, and an empty order is [] not a throw', async () => {
    stubFetch(200, [{ cf_payment_id: 9, order_id: 'rd_1', payment_status: 'SUCCESS', payment_amount: '187.00', payment_currency: 'INR' }])
    const [p] = await (await adapter()).fetchOrderPayments('rd_1')
    expect(p).toMatchObject({ providerPaymentId: '9', status: 'captured', amountPaise: 18700 })

    vi.resetModules(); stubFetch(200, null)
    expect(await (await adapter()).fetchOrderPayments('rd_1')).toEqual([])
  })

  it('surfaces an API error instead of pretending the order is unpaid', async () => {
    // Fail-closed matters here: "we could not ask" must never read as "nothing was paid".
    stubFetch(500, 'upstream exploded')
    await expect((await adapter()).fetchOrderPayments('rd_1')).rejects.toThrow(/failed 500/)
  })

  it('refund posts to the ORDER-scoped endpoint with a merchant refund id', async () => {
    const f = stubFetch(200, { cf_refund_id: 'cfr_1', refund_id: 'refund_rd_1', refund_status: 'PENDING' })
    const r = await (await adapter()).refund({
      providerPaymentId: '9', providerOrderId: 'rd_1', amountPaise: 18700,
      reason: 'super admin', receipt: 'refund_rd_1',
    })
    expect(r).toEqual({ provider: 'cashfree', providerRefundId: 'cfr_1', status: 'PENDING', amountPaise: 18700 })

    const [url, init] = f.mock.calls[0] as unknown as [string, { body: string }]
    expect(url).toBe(`${CASHFREE_SANDBOX_BASE}/orders/rd_1/refunds`)
    // The merchant-supplied refund_id is what makes a retry idempotent rather than a
    // second refund.
    expect(JSON.parse(init.body)).toMatchObject({ refund_id: 'refund_rd_1', refund_amount: '187.00' })
  })

  it('refund refuses without the order id rather than guessing one', async () => {
    stubFetch(200, {})
    await expect((await adapter()).refund({
      providerPaymentId: '9', amountPaise: 100, reason: 'x', receipt: 'y',
    })).rejects.toThrow(/providerOrderId/)
  })

  it('declares the capabilities it genuinely lacks instead of faking them', async () => {
    const a = await adapter()
    // Cashfree returns no signed browser payload, so a checkout "signature" cannot be
    // verified. FALSE is the safe answer: a caller asking "is this callback proof?" is told
    // no, forcing the server-side check.
    expect(await a.verifyCheckoutSignature({ providerOrderId: 'o', providerPaymentId: 'p', signature: 's' })).toBe(false)
    // And webhook verification needs the timestamp header, which this signature cannot see.
    await expect(a.verifyWebhookSignature('body', 'sig')).rejects.toThrow(/x-webhook-timestamp/)
  })
})

describe('RD-PAYMENT-CASHFREE-SANDBOX-05 · webhook signature', () => {
  const secret = 'TEST_SECRET'
  const body = '{"type":"PAYMENT_SUCCESS_WEBHOOK"}'
  const ts = '1759046400'
  const sign = (t: string, b: string, s = secret) =>
    nodeCrypto.createHmac('sha256', s).update(t + b).digest('base64')

  it('accepts a correct base64 signature over timestamp + raw body', () => {
    expect(verifyCashfreeWebhook(body, sign(ts, body), ts, secret)).toBe(true)
  })

  it('rejects a body modified after signing', () => {
    expect(verifyCashfreeWebhook(body + ' ', sign(ts, body), ts, secret)).toBe(false)
  })

  it('rejects a signature computed WITHOUT the timestamp prefix', () => {
    // The trap when porting from Razorpay, which signs the body alone. Omitting the
    // timestamp would let a valid body be replayed under any timestamp.
    const bodyOnly = nodeCrypto.createHmac('sha256', secret).update(body).digest('base64')
    expect(verifyCashfreeWebhook(body, bodyOnly, ts, secret)).toBe(false)
  })

  it('rejects a signature bound to a DIFFERENT timestamp', () => {
    expect(verifyCashfreeWebhook(body, sign('1', body), '2', secret)).toBe(false)
  })

  it('rejects the wrong secret', () => {
    expect(verifyCashfreeWebhook(body, sign(ts, body, 'OTHER'), ts, secret)).toBe(false)
  })

  it('rejects missing, empty and malformed signatures WITHOUT throwing', () => {
    // timingSafeEqual throws on a length mismatch; a bad signature must be a refusal, not a 500.
    for (const bad of ['', 'not-base64!!', 'YWJj', 'a'.repeat(100)]) {
      expect(verifyCashfreeWebhook(body, bad, ts, secret)).toBe(false)
    }
    expect(verifyCashfreeWebhook(body, sign(ts, body), '', secret)).toBe(false)
  })
})
