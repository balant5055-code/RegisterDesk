// RD-GA-HARDEN-01 — Razorpay mock helpers.
//
// The app verifies two HMAC-SHA256 signatures:
//   • payment signature: hmac(`${orderId}|${paymentId}`, key_secret)   (verify-payment)
//   • webhook signature: hmac(rawBody, webhook_secret)                 (webhooks)
// These helpers reproduce that signing so tests can assert the verification invariant
// (valid signature matches; any tamper fails). No network, no real Razorpay SDK.

import crypto from 'crypto'

export function signPaymentVerification(orderId: string, paymentId: string, keySecret: string): string {
  return crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex')
}

export function signWebhook(rawBody: string, webhookSecret: string): string {
  return crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex')
}

/** Timing-safe compare, mirroring the app's verification. */
export function signaturesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export function mockRazorpayOrder(over?: Partial<{ id: string; amount: number; currency: string; status: string }>) {
  return { id: 'order_MOCK123', amount: 100000, currency: 'INR', status: 'created', ...over }
}
