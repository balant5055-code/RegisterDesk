// MC-05 · Gateway refund duplicate-safety.
//
// The property under test is the one that costs real money if it breaks: `refundPayment`
// must pay an organizer AT MOST ONCE per refundId, no matter how many times it is called or
// where a previous attempt died.
//
// Razorpay is stubbed with a tiny in-memory gateway that behaves like the real one in the
// only respect that matters here — `refund()` creates a new refund every time it is called,
// and `fetchMultipleRefund()` lists what exists.

import { describe, it, expect, beforeEach, vi } from 'vitest'

interface StubRefund { id: string; notes: Record<string, unknown>; amount: number; status: string }

const gw = vi.hoisted(() => ({
  refunds: [] as StubRefund[],
  seq: 0,
  failFetch:  false,
  failCreate: false,
  createCalls: 0,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: 'secret',
  razorpay: {
    payments: {
      fetchMultipleRefund: async (paymentId: string) => {
        if (gw.failFetch) throw new Error('gateway unreachable')
        return { items: gw.refunds.filter(r => r.notes.paymentId === paymentId) }
      },
      refund: async (paymentId: string, params: { amount: number; notes: Record<string, unknown> }) => {
        gw.createCalls++
        if (gw.failCreate) throw new Error('refund declined')
        // Mirrors the real API: EVERY call creates a distinct refund. Nothing here dedupes.
        const r: StubRefund = {
          id: `rfnd_${++gw.seq}`,
          notes: { ...params.notes, paymentId },
          amount: params.amount,
          status: 'processed',
        }
        gw.refunds.push(r)
        return r
      },
    },
  },
}))

const { refundPayment, REFUND_TAG } = await import('@/features/media-credits/services/gatewayRefund')

const PAYMENT = 'pay_MC05test'
const REFUND  = 'refund_abc123'

beforeEach(() => {
  gw.refunds = []; gw.seq = 0
  gw.failFetch = false; gw.failCreate = false; gw.createCalls = 0
})

describe('refundPayment', () => {
  it('creates a refund tagged with our refundId', async () => {
    const out = await refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 })

    expect(out.reused).toBe(false)
    expect(out.gatewayRefundId).toBe('rfnd_1')
    // The tag is what makes the next call able to recognise this refund as ours.
    expect(gw.refunds[0].notes[REFUND_TAG]).toBe(REFUND)
    expect(gw.refunds[0].amount).toBe(9_000)
  })

  it('THE guarantee: a second call adopts the existing refund instead of paying twice', async () => {
    const first  = await refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 })
    const second = await refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 })

    expect(second.reused).toBe(true)
    expect(second.gatewayRefundId).toBe(first.gatewayRefundId)
    expect(gw.createCalls).toBe(1)     // the gateway was asked to create exactly once
    expect(gw.refunds).toHaveLength(1)
  })

  it('survives the dangerous window: created at the gateway, response lost, then retried', async () => {
    // Simulates the crash that a stored-id guard alone cannot cover — the refund exists at
    // Razorpay but we never recorded its id.
    gw.refunds.push({
      id: 'rfnd_orphan', notes: { [REFUND_TAG]: REFUND, paymentId: PAYMENT },
      amount: 9_000, status: 'processed',
    })

    const out = await refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 })
    expect(out.reused).toBe(true)
    expect(out.gatewayRefundId).toBe('rfnd_orphan')
    expect(gw.createCalls).toBe(0)     // never created a second one
  })

  it('does not adopt a refund belonging to a DIFFERENT refundId on the same payment', async () => {
    gw.refunds.push({
      id: 'rfnd_other', notes: { [REFUND_TAG]: 'some_other_refund', paymentId: PAYMENT },
      amount: 100, status: 'processed',
    })

    const out = await refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 })
    expect(out.reused).toBe(false)
    expect(out.gatewayRefundId).toBe('rfnd_1')
  })

  it('refuses to create when it cannot read existing refunds', async () => {
    // Fail CLOSED. Proceeding blind is how the same refund gets paid twice.
    gw.failFetch = true
    await expect(refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 }))
      .rejects.toThrow(/Could not confirm refund state/)
    expect(gw.createCalls).toBe(0)
  })

  it('propagates a gateway decline rather than reporting a false success', async () => {
    gw.failCreate = true
    await expect(refundPayment({ refundId: REFUND, paymentId: PAYMENT, amountPaise: 9_000 }))
      .rejects.toThrow('refund declined')
  })

  it.each([
    ['no payment reference', { paymentId: '',      amountPaise: 9_000 }],
    ['zero amount',          { paymentId: PAYMENT, amountPaise: 0 }],
    ['negative amount',      { paymentId: PAYMENT, amountPaise: -1 }],
  ])('refuses an unusable request (%s)', async (_label, args) => {
    await expect(refundPayment({ refundId: REFUND, ...args })).rejects.toThrow()
    expect(gw.createCalls).toBe(0)
  })
})
