// MC-04 · The PRODUCTION signature verifier, lib/razorpay/verifySignature.ts.
//
// Distinct from razorpaySignature.test.ts, which asserts the invariant of the test mock's
// own signer. This file exercises the real function the payment route calls.
//
// Signing reuses the existing `signPaymentVerification` mock helper rather than hand-rolling
// a second HMAC — a test that signs with its own copy of the rule can pass while the rule is
// wrong.
//
// The key secret is injected by mocking `@/lib/razorpay/client`, because importing it for
// real constructs a Razorpay SDK instance and this test has no business near the network.

import { describe, it, expect, vi } from 'vitest'
import crypto from 'crypto'
import { signPaymentVerification } from '../mocks/razorpay'

const SECRET = 'test_key_secret'

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID:     'rzp_test_stub',
  RAZORPAY_KEY_SECRET: SECRET,
  razorpay:            {},
}))

const { verifyRazorpaySignature } = await import('@/lib/razorpay/verifySignature')

const ORDER   = 'order_MC04test123'
const PAYMENT = 'pay_MC04test456'
const sign = (o: string, p: string, s = SECRET) => signPaymentVerification(o, p, s)

describe('verifyRazorpaySignature', () => {
  it('accepts a genuine signature', () => {
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: sign(ORDER, PAYMENT),
    })).toBe(true)
  })

  it('rejects a signature made with a different secret', () => {
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: sign(ORDER, PAYMENT, 'attacker_secret'),
    })).toBe(false)
  })

  it('rejects a genuine signature replayed against a DIFFERENT order', () => {
    // The core guarantee: a signature binds one payment to one order and nothing else.
    expect(verifyRazorpaySignature({
      orderId: 'order_someone_elses', paymentId: PAYMENT, signature: sign(ORDER, PAYMENT),
    })).toBe(false)
  })

  it('rejects a genuine signature with a substituted payment id', () => {
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: 'pay_substituted', signature: sign(ORDER, PAYMENT),
    })).toBe(false)
  })

  it('rejects a single-character mutation', () => {
    const good = sign(ORDER, PAYMENT)
    const bad  = (good[0] === 'a' ? 'b' : 'a') + good.slice(1)
    expect(verifyRazorpaySignature({ orderId: ORDER, paymentId: PAYMENT, signature: bad })).toBe(false)
  })

  // ── A documented property of Razorpay's scheme, NOT a defect in this verifier ──
  //
  // The signed message is `${orderId}|${paymentId}`, so the split point is not recoverable:
  // ("order_X", "Y|pay_Z") and ("order_X|Y", "pay_Z") both sign the string "order_X|Y|pay_Z"
  // and therefore share a signature. No verifier implementing Razorpay's documented scheme
  // can distinguish them, and we cannot change the scheme.
  //
  // It is not exploitable in this flow, for three independent reasons:
  //   1. Razorpay ids are `order_`/`pay_` + alphanumerics. Neither can contain a pipe.
  //   2. `completePurchase` looks the orderId up in Firestore — it must be an order WE
  //      created — and rejects anything else as `unknown_order`.
  //   3. It then asserts `payment.order_id === orderId` against Razorpay's own record.
  //
  // The test asserts the true behaviour rather than a comfortable falsehood, so that if a
  // future change DOES make the split recoverable, this documents what changed.
  it('shares a signature across an ambiguous split (Razorpay scheme property)', () => {
    const merged = sign('order_X', 'Y|pay_Z')
    expect(verifyRazorpaySignature({
      orderId: 'order_X|Y', paymentId: 'pay_Z', signature: merged,
    })).toBe(true)
  })

  it('rejects an ambiguous split once the ids are realistic (no pipe possible)', () => {
    // With real Razorpay-shaped ids the ambiguity has no reachable instance.
    expect(verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: sign(`${ORDER}|${PAYMENT}`, ''),
    })).toBe(false)
  })

  // ── The length/format guard ────────────────────────────────────────────────
  // Load-bearing: `timingSafeEqual` THROWS on unequal buffer lengths. Without the regex a
  // short signature would produce a 500 distinguishable from a 400 — both a crash and a
  // side channel.
  it.each([
    ['empty',     ''],
    ['too short', 'abc123'],
    ['too long',  'a'.repeat(66)],
    ['non-hex',   'z'.repeat(64)],
    ['uppercase', 'A'.repeat(64)],
    ['spaces',    ' '.repeat(64)],
  ])('rejects a malformed signature (%s) without throwing', (_label, signature) => {
    expect(() => verifyRazorpaySignature({ orderId: ORDER, paymentId: PAYMENT, signature }))
      .not.toThrow()
    expect(verifyRazorpaySignature({ orderId: ORDER, paymentId: PAYMENT, signature })).toBe(false)
  })

  it('rejects a missing orderId or paymentId', () => {
    expect(verifyRazorpaySignature({ orderId: '', paymentId: PAYMENT, signature: sign('', PAYMENT) })).toBe(false)
    expect(verifyRazorpaySignature({ orderId: ORDER, paymentId: '', signature: sign(ORDER, '') })).toBe(false)
  })
})

describe('verifyRazorpaySignature · fail-closed on misconfiguration', () => {
  it('returns false when the key secret is absent, even for a correctly-signed payload', async () => {
    vi.resetModules()
    vi.doMock('@/lib/razorpay/client', () => ({
      RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', razorpay: {},
    }))
    const mod = await import('@/lib/razorpay/verifySignature')

    // An empty string is still a usable HMAC key. Without the explicit guard, anyone who
    // knew the deployment was misconfigured could sign their own payloads and be believed.
    const forged = crypto.createHmac('sha256', '').update(`${ORDER}|${PAYMENT}`).digest('hex')
    expect(mod.verifyRazorpaySignature({
      orderId: ORDER, paymentId: PAYMENT, signature: forged,
    })).toBe(false)

    vi.doUnmock('@/lib/razorpay/client')
    vi.resetModules()
  })
})
