// W1 — the pure refund-webhook rules: the documented Razorpay payload, cumulative accounting, and the
// failed-refund guards.

import { describe, it, expect } from 'vitest'
import {
  parseRazorpayRefundEvent, accumulateRefund, canApplySideEffects, isCountedRefund, buildLinkagePatch,
} from '@/lib/refunds/refundPolicy'

// Sanitized from https://razorpay.com/docs/webhooks/payloads/refunds/ ("contains": ["refund","payment"]).
const doc = (over: { refund?: Record<string, unknown>; payment?: Record<string, unknown> | null } = {}) => ({
  refund: { entity: { id: 'rfnd_1', entity: 'refund', amount: 50000, currency: 'INR', payment_id: 'pay_1', notes: {}, receipt: null, status: 'processed', ...over.refund } },
  ...(over.payment === null ? {} : { payment: { entity: { id: 'pay_1', entity: 'payment', amount: 50000, currency: 'INR', status: 'captured', order_id: 'order_1', ...over.payment } } }),
})

describe('parseRazorpayRefundEvent', () => {
  it('takes the order ONLY from the payment entity of the refund\'s own payment', () => {
    const r = parseRazorpayRefundEvent(doc())
    expect(r).toEqual({ ok: true, event: expect.objectContaining({ refundId: 'rfnd_1', amountPaise: 50000, paymentId: 'pay_1', orderId: 'order_1', paymentMismatch: false, currency: 'INR', paymentAmountPaise: 50000 }) })
  })
  it('never trusts an order_id on the refund entity (not part of the contract)', () => {
    const r = parseRazorpayRefundEvent(doc({ refund: { order_id: 'order_FORGED' }, payment: null }))
    expect(r.ok && r.event.orderId).toBe(null)
  })
  it('a payment entity naming ANOTHER payment is a mismatch: no order is taken', () => {
    const r = parseRazorpayRefundEvent(doc({ payment: { id: 'pay_other' } }))
    expect(r.ok && r.event).toMatchObject({ paymentMismatch: true, orderId: null })
  })
  it('rejects payloads that cannot be recorded safely', () => {
    expect(parseRazorpayRefundEvent({})).toEqual({ ok: false, reason: 'missing_refund_entity' })
    expect(parseRazorpayRefundEvent(doc({ refund: { id: '' } }))).toEqual({ ok: false, reason: 'missing_refund_id' })
    for (const amount of [0, -1, 12.5, '500', null]) expect(parseRazorpayRefundEvent(doc({ refund: { amount } }))).toEqual({ ok: false, reason: 'invalid_amount' })
    expect(parseRazorpayRefundEvent(doc({ refund: { payment_id: undefined } }))).toEqual({ ok: false, reason: 'missing_payment_id' })
  })
})

describe('accumulateRefund (integer paise against the charged amount)', () => {
  it('partial, then full exactly at the charge; the same id again is a duplicate', () => {
    expect(accumulateRefund(undefined, 'a', 20000, 50000)).toEqual({ kind: 'partial', priorPaise: 0, totalPaise: 20000 })
    expect(accumulateRefund({ a: 20000 }, 'b', 30000, 50000)).toEqual({ kind: 'full', priorPaise: 20000, totalPaise: 50000 })
    expect(accumulateRefund({ a: 20000 }, 'a', 20000, 50000)).toEqual({ kind: 'duplicate' })
    expect(accumulateRefund(undefined, 'a', 50000, 50000)).toEqual({ kind: 'full', priorPaise: 0, totalPaise: 50000 })
  })
  it('never silently clamps: exceeding the charge, or refunding after full, is reported', () => {
    expect(accumulateRefund({ a: 40000 }, 'b', 20000, 50000)).toEqual({ kind: 'exceeds', priorPaise: 40000, totalPaise: 60000 })
    expect(accumulateRefund({ a: 50000 }, 'b', 1, 50000)).toEqual({ kind: 'already_full', priorPaise: 50000, totalPaise: 50001 })
  })
  it('ignores malformed stored entries rather than counting them', () => {
    expect(accumulateRefund({ a: 'x', b: -5, c: 1.5, d: 10000 }, 'e', 10000, 50000)).toEqual({ kind: 'partial', priorPaise: 10000, totalPaise: 20000 })
  })
})

describe('failed refunds', () => {
  it('a failed refund never gets side effects and is never counted as money out', () => {
    expect(canApplySideEffects('failed')).toBe(false)
    expect(canApplySideEffects('processed')).toBe(false)
    expect(canApplySideEffects('linked')).toBe(true)
    expect(isCountedRefund('failed')).toBe(false)
    for (const s of ['recorded', 'linked', 'processed', 'unlinked'] as const) expect(isCountedRefund(s)).toBe(true)
  })
  it('a linkage fill-in never reopens a failed (or processed) refund', () => {
    const resolved = { registrationId: 'r1', eventSlug: 'e', organizerUid: 'o' }
    expect(buildLinkagePatch({ registrationId: null, eventSlug: null, organizerUid: null, status: 'failed' }, resolved)?.status).toBe('failed')
    expect(buildLinkagePatch({ registrationId: null, eventSlug: null, organizerUid: null, status: 'processed' }, resolved)?.status).toBe('processed')
    expect(buildLinkagePatch({ registrationId: null, eventSlug: null, organizerUid: null, status: 'unlinked' }, resolved)?.status).toBe('linked')
  })
})
