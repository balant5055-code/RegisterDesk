// RD-REGISTRATIONS-DATA-AND-EXPORT — the payment presentation rules shared by the
// registrations drawer and the export.
//
// SCOPE, HONESTLY: this repo has no DOM test environment (no jsdom, no testing-library,
// zero component tests), and adding one is outside this sprint. So the drawer's RENDERING
// is not asserted here — what IS asserted is the branch condition that decides between a
// payment block and "No payment required", and the refund wording, both of which the
// drawer now calls directly rather than re-implementing inline.

import { describe, it, expect } from 'vitest'
import { hasPaymentRecord, refundLabel } from '@/lib/registrations/paymentDisplay'
import type { RegistrationDocument } from '@/lib/registrations/types'

describe('hasPaymentRecord — drawer shows payment details vs "No payment required"', () => {
  it('a paid registration has a payment record', () => {
    expect(hasPaymentRecord({ amount: 149000, paymentStatus: 'paid', paymentId: 'pay_1' })).toBe(true)
  })

  it('a free registration does NOT — the drawer must say "No payment required"', () => {
    expect(hasPaymentRecord({ amount: 0, paymentStatus: 'not_required' })).toBe(false)
  })

  it('a fully-discounted ₹0 registration that still went through Razorpay DOES', () => {
    // A 100%-off coupon still produces a gateway payment id worth reconciling against.
    // Testing amount alone would hide it behind "No payment required".
    expect(hasPaymentRecord({ amount: 0, paymentStatus: 'paid', paymentId: 'pay_zero' })).toBe(true)
  })

  it('a walk-in cash registration with an amount but no gateway id DOES', () => {
    expect(hasPaymentRecord({ amount: 50000, paymentStatus: 'paid' })).toBe(true)
  })

  it('tolerates missing fields on a legacy record', () => {
    expect(hasPaymentRecord({})).toBe(false)
    expect(hasPaymentRecord({ amount: null, paymentId: null })).toBe(false)
  })
})

describe('refundLabel — one wording for the drawer and the export', () => {
  it('reads the persisted refunded status', () => {
    expect(refundLabel({ paymentStatus: 'refunded' })).toBe('Refunded')
  })

  it('reads refund_pending, which the payment filter now also exposes', () => {
    expect(refundLabel({ paymentStatus: 'refund_pending' })).toBe('Refund pending')
  })

  it('reports a gateway refund whose local status has not caught up yet', () => {
    expect(refundLabel({ paymentStatus: 'paid', refundId: 'rfnd_1' })).toBe('Refund issued')
  })

  it('is null when no refund exists, so no empty refund rows render', () => {
    expect(refundLabel({ paymentStatus: 'paid' })).toBeNull()
    expect(refundLabel({})).toBeNull()
  })
})

// ─── Type-model correction ────────────────────────────────────────────────────
//
// paymentId / razorpayOrderId / ticket.ticketId were written by the paid path from day
// one but were never DECLARED, so TypeScript hid them from every consumer and the table,
// drawer and export all silently dropped data that was already present. These assertions
// fail to COMPILE if the declarations are removed again — a runtime expect() alone would
// not catch that, since the fields would still be there at runtime.

describe('RegistrationDocument declares the persisted Razorpay identifiers', () => {
  it('accepts paymentId, razorpayOrderId and ticket.ticketId', () => {
    const reg: Pick<RegistrationDocument, 'paymentId' | 'razorpayOrderId' | 'ticket'> = {
      paymentId:       'pay_QxKf82hAsdLm01',
      razorpayOrderId: 'order_QxKf7wVv11Aa22',
      ticket: { ticketId: 'reg-1', qrValue: 'RD:x', qrGeneratedAt: null },
    }
    expect(reg.paymentId).toBe('pay_QxKf82hAsdLm01')
    expect(reg.razorpayOrderId).toBe('order_QxKf7wVv11Aa22')
    expect(reg.ticket?.ticketId).toBe('reg-1')
  })

  it('keeps them OPTIONAL — free, walk-in and imported registrations have neither', () => {
    const free: Pick<RegistrationDocument, 'paymentId' | 'razorpayOrderId'> = {}
    expect(free.paymentId).toBeUndefined()
    expect(free.razorpayOrderId).toBeUndefined()
  })
})
