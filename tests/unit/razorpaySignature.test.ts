// RD-GA-HARDEN-01 — Razorpay HMAC signature invariant (the property the app's
// verify-payment + webhook handlers rely on). Uses the Razorpay mock signer.

import { describe, it, expect } from 'vitest'
import { signPaymentVerification, signWebhook, signaturesMatch, mockRazorpayOrder } from '../mocks/razorpay'

const KEY_SECRET = 'test_key_secret'
const WEBHOOK_SECRET = 'test_webhook_secret'

describe('payment verification signature (order|payment)', () => {
  it('a correctly-signed payment verifies', () => {
    const order = mockRazorpayOrder()
    const paymentId = 'pay_MOCK999'
    const sig = signPaymentVerification(order.id, paymentId, KEY_SECRET)
    expect(signaturesMatch(sig, signPaymentVerification(order.id, paymentId, KEY_SECRET))).toBe(true)
  })

  it('tampering with the payment id fails verification', () => {
    const good = signPaymentVerification('order_1', 'pay_1', KEY_SECRET)
    expect(signaturesMatch(good, signPaymentVerification('order_1', 'pay_TAMPERED', KEY_SECRET))).toBe(false)
  })

  it('a wrong secret fails verification', () => {
    const good = signPaymentVerification('order_1', 'pay_1', KEY_SECRET)
    expect(signaturesMatch(good, signPaymentVerification('order_1', 'pay_1', 'attacker_secret'))).toBe(false)
  })
})

describe('webhook signature (raw body)', () => {
  it('verifies the exact raw body and rejects any mutation', () => {
    const body = JSON.stringify({ event: 'payment.captured', id: 'evt_1' })
    const sig = signWebhook(body, WEBHOOK_SECRET)
    expect(signaturesMatch(sig, signWebhook(body, WEBHOOK_SECRET))).toBe(true)
    expect(signaturesMatch(sig, signWebhook(body + ' ', WEBHOOK_SECRET))).toBe(false)
  })

  it('signaturesMatch is length-safe (no throw on mismatched lengths)', () => {
    expect(signaturesMatch('abc', 'abcdef')).toBe(false)
  })
})
