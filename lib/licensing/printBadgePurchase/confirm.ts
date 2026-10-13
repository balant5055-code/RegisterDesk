// RD-PRINT-BILL-P4 · The client confirmation of a badge purchase payment (called from
// /api/licensing/checkout/confirm for an orderId `bdg_…`). Server-only.
//
// Verifies what the client says against Razorpay (HMAC signature, then the FETCHED payment: captured,
// INR, the order's exact amount, the order's own Razorpay order id) and hands a verified capture to
// settleBadgePayment — the same function the webhook and the sweep use. Nothing in the body is trusted
// for money: amounts come from the immutable order.

import { NextResponse } from 'next/server'
import { razorpay } from '@/lib/razorpay/client'
import { RazorpayDonationGateway } from '@/lib/razorpay/donationGateway'
import { recordBadgeSuspiciousPayment } from './suspicious'
import { BADGE_ORDER_PURPOSE } from './pricing'
import { badgeOrderRef, isBadgeOrderId, type BadgeOrderDoc } from './orderDoc'
import { settleBadgePayment } from './settle'

const verifier = new RazorpayDonationGateway()
const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const HELD_MESSAGE = 'Your payment was received, but the badges could not be applied, so nothing was applied. Your payment is on hold for review by the RegisterDesk team — please do not pay again.'

export async function confirmBadgePurchase(a: {
  uid: string; isOwner: boolean; eventId: string; orderId: string
  body: { razorpay_order_id?: unknown; razorpay_payment_id?: unknown; razorpay_signature?: unknown }
}): Promise<NextResponse> {
  if (!a.isOwner) return json({ error: 'Only the event owner can confirm badge purchases.', code: 'OWNER_REQUIRED' }, 403)
  if (!isBadgeOrderId(a.orderId)) return json({ error: 'Order not found.' }, 404)
  const snap = await badgeOrderRef(a.orderId).get()
  const o = snap.exists ? snap.data() as BadgeOrderDoc : undefined
  if (!o || o.purpose !== BADGE_ORDER_PURPOSE || o.organizerUid !== a.uid || (o.eventSlug !== a.eventId && o.eventId !== a.eventId)) {
    return json({ error: 'Order not found.' }, 404)
  }
  if (!o.razorpayOrderId) return json({ error: 'This purchase has no payment to confirm.' }, 409)
  const rzpOrderId = typeof a.body.razorpay_order_id === 'string' ? a.body.razorpay_order_id : null
  const paymentId  = typeof a.body.razorpay_payment_id === 'string' ? a.body.razorpay_payment_id : null
  const signature  = typeof a.body.razorpay_signature === 'string' ? a.body.razorpay_signature : null
  if (!rzpOrderId || !paymentId || !signature) return json({ error: 'Payment details are required' }, 400)
  if (rzpOrderId !== o.razorpayOrderId) return json({ error: 'Payment order mismatch. Please restart checkout.' }, 400)
  if (!verifier.verifySignature({ orderId: rzpOrderId, paymentId, signature })) {
    console.warn(`[badge] payment verification FAILED · order=${a.orderId}`)
    return json({ error: 'Invalid payment signature' }, 400)
  }
  let pay: { amount?: number; currency?: string; status?: string; order_id?: string }
  try { pay = await razorpay.payments.fetch(paymentId) as typeof pay } catch {
    return json({ error: 'Could not verify payment. Please try again.' }, 502)
  }
  const matches = pay.currency === 'INR' && pay.amount === o.razorpayAmountPaise && pay.order_id === o.razorpayOrderId
  if (matches && pay.status === 'authorized') {
    return json({ error: 'Your payment is authorised but not yet captured by Razorpay, so nothing has been applied yet. It is applied automatically once captured — please do not pay again.', code: 'PAYMENT_NOT_CAPTURED' }, 409)
  }
  if (!matches || pay.status !== 'captured') {
    // RD-PRINT-BILL-P4.2 — a signed payment on this order that does not match it: recorded DURABLY
    // (idempotent, keyed by the payment). If that cannot be committed, answer 503 — never a final 400.
    try {
      await recordBadgeSuspiciousPayment({
        reason: 'amount_or_order_mismatch', paymentId, razorpayOrderId: rzpOrderId, badgeOrderId: a.orderId, eventId: o.eventId,
        expectedAmountPaise: o.razorpayAmountPaise, actualAmountPaise: pay.amount ?? null, expectedCurrency: 'INR', actualCurrency: pay.currency ?? null,
        expectedOrderId: o.razorpayOrderId, actualOrderId: pay.order_id ?? null, detectedBy: 'confirm',
      })
    } catch {
      return json({ error: 'Your payment could not be verified right now. Please try again in a moment — please do not pay again.', code: 'PAYMENT_PROCESSING' }, 503)
    }
    return json({ error: 'Payment verification failed.' }, 400)
  }
  let r
  try {
    r = await settleBadgePayment({ orderId: a.orderId, razorpayOrderId: rzpOrderId, paymentId, amountPaise: pay.amount, currency: pay.currency, via: 'confirm' })
  } catch {
    // Neither applied nor held yet: the webhook (redelivered until acknowledged) and the sweep finish it.
    return json({ error: 'Your payment is being processed. Refresh in a moment — please do not pay again.', code: 'PAYMENT_PROCESSING' }, 503)
  }
  if (r.kind === 'activated' || r.kind === 'already') {
    return json({ success: true, orderId: a.orderId, alreadyPaid: r.kind === 'already', quantity: o.badgePurchase.quantity })
  }
  if (r.kind === 'held' || r.kind === 'duplicate_held') return json({ error: HELD_MESSAGE, code: 'PAYMENT_HELD' }, 409)
  return json({ error: 'This order could not be verified. Please contact support.' }, 409)
}
