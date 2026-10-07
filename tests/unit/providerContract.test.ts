// RD-PAYMENT-PROVIDER-CONTRACT-04 — the contract every payment provider must satisfy.
//
// ═══ WHY THIS IS WRITTEN AGAINST THE CONTRACT, NOT AGAINST RAZORPAY ══════════
// These cases drive `razorpayAdapter` through the `PaymentProviderAdapter` type, with the
// Razorpay SDK stubbed. Nothing below mentions a Razorpay field name outside the stub.
//
// That is the point: when the Cashfree adapter lands, this file should run against it by
// changing which adapter is imported. A contract suite that can only describe one provider
// is just a unit test with extra ceremony.
//
// The normalization details asserted here are the ones that silently corrupt money or state
// if a provider gets them wrong — paise vs rupees, seconds vs milliseconds, and an unknown
// status being read as success.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const sdk = vi.hoisted(() => ({
  orders: {
    create:        vi.fn(async () => ({ id: 'order_ABC' })),
    fetchPayments: vi.fn(async () => ({ items: [] as unknown[] })),
  },
  payments: {
    fetch:  vi.fn(async () => null as unknown),
    refund: vi.fn(async () => ({ id: 'rfnd_1', status: 'processed' })),
  },
}))

vi.mock('@/lib/razorpay/client', () => ({
  razorpay: sdk,
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: 'stub_secret',
}))
vi.mock('@/lib/env', () => ({ RAZORPAY_WEBHOOK_SECRET: 'stub_webhook_secret', required: () => {} }))

import type { PaymentProviderAdapter, RefundProviderAdapter } from '@/lib/payments/providers/types'

async function adapter(): Promise<PaymentProviderAdapter & RefundProviderAdapter> {
  const { razorpayAdapter } = await import('@/lib/payments/providers/razorpayAdapter')
  return razorpayAdapter
}

describe('RD-PAYMENT-PROVIDER-CONTRACT-04 · provider contract (Razorpay adapter)', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('declares its identity', async () => {
    expect((await adapter()).id).toBe('razorpay')
  })

  describe('createOrder', () => {
    it('returns a normalized order and passes the amount through in PAISE', async () => {
      const order = await (await adapter()).createOrder({
        amountPaise: 18700, currency: 'INR', receipt: 'rd_1',
      })
      // RD-PAYMENT-CASHFREE-CHECKOUT-06 — the order now also carries what the BROWSER needs
      // to open this provider's checkout. For Razorpay that is the publishable key id, which
      // create-order previously imported and emitted itself.
      expect(order).toEqual({
        provider: 'razorpay', providerOrderId: 'order_ABC', amountPaise: 18700, currency: 'INR',
        checkout: { provider: 'razorpay', keyId: 'rzp_test_stub' },
      })
      // Unit integrity: the gateway is asked for the same integer it was given. A silent
      // rupee/paise conversion here would charge 100× or 1/100×.
      expect(sdk.orders.create).toHaveBeenCalledWith({ amount: 18700, currency: 'INR', receipt: 'rd_1' })
    })
  })

  describe('fetchOrderPayments', () => {
    it('normalizes every payment on the order', async () => {
      sdk.orders.fetchPayments.mockResolvedValueOnce({
        items: [{ id: 'pay_1', order_id: 'order_ABC', status: 'captured', amount: 18700, currency: 'INR', created_at: 1_700_000_000 }],
      })
      const [p] = await (await adapter()).fetchOrderPayments('order_ABC')
      expect(p).toEqual({
        provider: 'razorpay', providerPaymentId: 'pay_1', providerOrderId: 'order_ABC',
        status: 'captured', amountPaise: 18700, currency: 'INR',
        // Razorpay reports SECONDS. Leaving that for callers to remember is how a timestamp
        // ends up in 1970.
        capturedAtMs: 1_700_000_000_000,
      })
    })

    it('maps every provider status onto the normalized vocabulary', async () => {
      for (const [raw, normalized] of [
        ['created', 'created'], ['authorized', 'authorized'], ['captured', 'captured'],
        ['refunded', 'refunded'], ['failed', 'failed'],
      ] as const) {
        sdk.orders.fetchPayments.mockResolvedValueOnce({ items: [{ id: 'p', status: raw, amount: 1, currency: 'INR' }] })
        const [p] = await (await adapter()).fetchOrderPayments('o')
        expect(p.status, `${raw} should normalize to ${normalized}`).toBe(normalized)
      }
    })

    it('reads an UNKNOWN status as failed — never as captured', async () => {
      // The safe direction, and the one that matters: an unrecognised status read as
      // `captured` would settle a registration against money nobody has.
      sdk.orders.fetchPayments.mockResolvedValueOnce({ items: [{ id: 'p', status: 'something_new', amount: 1, currency: 'INR' }] })
      const [p] = await (await adapter()).fetchOrderPayments('o')
      expect(p.status).toBe('failed')
    })

    it('an order with no payments normalizes to an empty list, not a throw', async () => {
      sdk.orders.fetchPayments.mockResolvedValueOnce({})
      expect(await (await adapter()).fetchOrderPayments('o')).toEqual([])
    })
  })

  describe('signature verification', () => {
    it('accepts a correctly signed checkout callback', async () => {
      const crypto = await import('crypto')
      const sig = crypto.createHmac('sha256', 'stub_secret').update('order_1|pay_1').digest('hex')
      expect(await (await adapter()).verifyCheckoutSignature({
        providerOrderId: 'order_1', providerPaymentId: 'pay_1', signature: sig,
      })).toBe(true)
    })

    it('rejects a wrong signature, and rejects malformed input WITHOUT throwing', async () => {
      const a = await adapter()
      expect(await a.verifyCheckoutSignature({ providerOrderId: 'order_1', providerPaymentId: 'pay_1', signature: 'f'.repeat(64) })).toBe(false)
      // Malformed lengths must be refused before any comparison — timingSafeEqual throws on
      // a length mismatch, which would turn a bad signature into a 500 instead of a refusal.
      for (const bad of ['', 'abc', 'zz'.repeat(32), 'A'.repeat(64)]) {
        expect(await a.verifyCheckoutSignature({ providerOrderId: 'o', providerPaymentId: 'p', signature: bad })).toBe(false)
      }
    })

    it('verifies a webhook signature over the RAW body', async () => {
      const crypto = await import('crypto')
      const body = '{"event":"payment.captured"}'
      const sig = crypto.createHmac('sha256', 'stub_webhook_secret').update(body).digest('hex')
      const a = await adapter()
      expect(await a.verifyWebhookSignature(body, sig)).toBe(true)
      expect(await a.verifyWebhookSignature(body + ' ', sig)).toBe(false)
    })
  })

  describe('refund', () => {
    it('normalizes the refund result', async () => {
      const r = await (await adapter()).refund({
        providerPaymentId: 'pay_1', amountPaise: 18700, reason: 'super_admin', receipt: 'refund_1',
      })
      expect(r).toEqual({ provider: 'razorpay', providerRefundId: 'rfnd_1', status: 'processed', amountPaise: 18700 })
    })

    it('exposes NO authorization surface — authority lives above the adapter', async () => {
      // RD-PAYMENT-REFUND-AUTHORITY-02: refunds are Super-Admin-only, enforced in
      // RegisterDesk. An adapter that offered `mayRefund()` or took an actor would be a
      // second place that decides, which is what that phase eliminated.
      const a = await adapter()
      expect(Object.keys(a)).not.toContain('mayRefund')
      expect(a.refund.length).toBe(1)   // one input object; no actor argument
    })
  })
})
