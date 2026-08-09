// Canonical Razorpay HMAC signature verification — SERVER ONLY.
//
// ═══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════
// Before MC-04 this rule was written out by hand in three separate routes
// (registrations/verify-payment, wallet/topup/verify, razorpay/donationGateway). A
// security-critical comparison duplicated per call site is one careless edit away from
// diverging, and the divergence would be silent — a weakened check still returns `true` for
// every legitimate payment, so no test and no user would notice.
//
// MC-04 needed a fourth copy. It gets this instead.
//
// ═══ WHAT MAKES THE COMPARISON SAFE ══════════════════════════════════════════
// Two things, and both are load-bearing:
//
//   1. The hex-length guard runs FIRST. `timingSafeEqual` THROWS on unequal buffer lengths,
//      so an attacker sending a short signature would get a 500 that is distinguishable from
//      a 400 — a side channel, and an unhandled crash. Rejecting non-64-hex up front means
//      the buffer below is always exactly 32 bytes.
//
//   2. `timingSafeEqual`, never `===`. String comparison short-circuits on the first
//      differing byte, leaking how much of a forged prefix was correct.
//
// The digest is compared as a raw Buffer rather than a hex string: same bytes, half the
// length to compare, and no case-sensitivity question to get wrong.

import crypto from 'crypto'
import { RAZORPAY_KEY_SECRET } from '@/lib/razorpay/client'

/** Razorpay signs with SHA-256, so a valid signature is always 64 lowercase hex chars. */
const HEX_64 = /^[0-9a-f]{64}$/

export interface RazorpayCheckoutSignature {
  orderId:   string
  paymentId: string
  signature: string
}

/**
 * Verifies a Razorpay CHECKOUT signature — `HMAC_SHA256(orderId|paymentId, keySecret)`.
 *
 * This is the signature the browser receives from Razorpay Checkout and posts back. It
 * proves the payment belongs to the order, and nothing more: it does NOT prove the amount,
 * the currency, or that the payment was actually captured. Callers must still re-fetch the
 * payment from Razorpay and assert those independently — see the verify route.
 *
 * Returns `false` rather than throwing for every rejection path, including a missing
 * secret, so a caller cannot accidentally treat a configuration error as a pass.
 */
export function verifyRazorpaySignature(input: RazorpayCheckoutSignature): boolean {
  const { orderId, paymentId, signature } = input

  // A missing secret must fail CLOSED. Without this guard `createHmac` would happily sign
  // with an empty key, and an attacker who knows the deployment is misconfigured could
  // compute a matching signature themselves.
  if (!RAZORPAY_KEY_SECRET) return false
  if (!orderId || !paymentId) return false
  if (!HEX_64.test(signature)) return false

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest()                                  // raw Buffer, 32 bytes

  const actual = Buffer.from(signature, 'hex') // 32 bytes, guaranteed by HEX_64

  return crypto.timingSafeEqual(expected, actual)
}
