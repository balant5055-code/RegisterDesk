// POST /api/registrations/payment-status
//
// RD-PAY-P0-2 — READ ONLY. Answers one question: what is the true state of this order?
//
// WHY THIS EXISTS. Razorpay's checkout `handler` fires only after money has been taken, so
// a failed verify-payment does NOT mean the payment failed — usually it means the attendee's
// phone lost signal between paying and telling us. The old client could not tell those two
// apart, showed "please try again", and let the attendee mint a second order. This endpoint
// is how the client resolves the ambiguity WITHOUT creating anything.
//
// It writes nothing: no intent update, no registration, no refund, no wallet movement. The
// authoritative settlement paths are unchanged — verify-payment (client) and the
// payment.captured webhook (out of band). This route only reports.
//
// Security: the caller must already hold the Razorpay order id, which is issued only to the
// browser that created it. Nothing here reveals more than that browser already had — the
// response carries no attendee PII beyond the registration id it is entitled to redeem.

import { NextRequest, NextResponse } from 'next/server'
import { getPaymentIntent, getAttemptClaim } from '@/lib/firebase/firestore/paymentIntents'
import { normalizeIdempotencyKey, attemptClaimId } from '@/lib/registrations/paymentAttempt'
import { razorpay }         from '@/lib/razorpay/client'
import { getClientIp }      from '@/lib/rateLimit'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { captureFinancialError }     from '@/lib/monitoring/sentry'

export type PaymentStatusState =
  /** Settled. A registration exists for this order. */
  | 'confirmed'
  /**
   * Razorpay holds a captured (or authorized) payment, but no registration has been created
   * yet. Recovery is in flight — verify-payment or the webhook will finish it. The attendee
   * must NOT pay again.
   */
  | 'captured_unsettled'
  /** Terminal and refused. Anything captured has already been refunded. Retry is safe. */
  | 'failed'
  /** No payment has been taken against this order. The SAME order may be paid. */
  | 'awaiting_payment'
  /**
   * RD-PAY-P0-5. Looked up by ATTEMPT, and that attempt never claimed an order — so the
   * browser's create-order call did not get far enough to produce one it could have paid.
   * A fresh attempt is safe.
   */
  | 'no_order'
  /** We could not determine the state. Treated exactly like captured_unsettled. */
  | 'unknown'

export interface PaymentStatusResponse {
  state:           PaymentStatusState
  registrationId?: string
  /** True when the attendee may safely start a NEW payment. Only ever set for terminal states. */
  canRetry:        boolean
  reason?:         string
}

export async function POST(req: NextRequest): Promise<NextResponse<PaymentStatusResponse>> {
  // Polled by the recovery UI, so the budget is generous — but bounded.
  const rl = await checkDistributedRateLimit({
    key: `payment-status:${getClientIp(req)}`, limit: 60, windowSeconds: 10 * 60, failOpen: true,
  })
  if (!rl.allowed) {
    // Deliberately NOT canRetry — a throttled poll has learned nothing.
    return NextResponse.json({ state: 'unknown', canRetry: false }, { status: 429 })
  }

  let body: { orderId?: string; idempotencyKey?: string; slug?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ state: 'unknown', canRetry: false }, { status: 400 })
  }

  let orderId = (body.orderId ?? '').trim()

  // RD-PAY-P0-5 — resolve by ATTEMPT when the browser never received an order id (a
  // create-order request that timed out or lost its response). The attempt claim written by
  // create-order step 9b is the existing index from key → order; nothing new is introduced.
  if (!orderId) {
    const key  = normalizeIdempotencyKey(body.idempotencyKey)
    const slug = (body.slug ?? '').trim()
    if (!key || !slug) return NextResponse.json({ state: 'unknown', canRetry: false }, { status: 400 })

    const claim = await getAttemptClaim(attemptClaimId(slug, key)).catch(() => null)

    // NO CLAIM ⇒ NO PAYABLE ORDER, and this is safe to state rather than merely hope.
    // create-order writes the Razorpay order, then the intent, then the claim, and only
    // then responds. So if a claim is absent, one of two things happened: nothing was
    // created at all, or the process died before claiming. In BOTH cases the browser never
    // received an order id — which is the only way it could have opened checkout — so no
    // payment can exist against this attempt. Any Razorpay order stranded by the second
    // case is unpaid and expires on its own.
    if (!claim?.orderId) return NextResponse.json({ state: 'no_order', canRetry: true })

    orderId = claim.orderId
  }

  const intent = await getPaymentIntent(orderId).catch(() => null)

  // No intent at all. This is NOT "safe to retry": create-order writes the intent before it
  // ever returns an order id, so a caller holding an order id whose intent is missing is in
  // an unexplained state. Report unknown and let the recovery UI keep asking.
  if (!intent) return NextResponse.json({ state: 'unknown', canRetry: false })

  if (intent.status === 'paid' && intent.registrationId) {
    return NextResponse.json({ state: 'confirmed', registrationId: intent.registrationId, canRetry: false })
  }

  // Terminal: verify-payment and the webhook both refund BEFORE marking an intent failed,
  // so a fresh attempt here cannot double-charge.
  if (intent.status === 'registration_failed' || intent.status === 'failed' ||
      intent.refundId !== undefined || intent.refundStatus !== undefined) {
    return NextResponse.json({
      state: 'failed', canRetry: true,
      ...(intent.failureReason ? { reason: intent.failureReason } : {}),
    })
  }

  // Still 'created'. Ask the authority whether money was actually taken.
  try {
    const res = await razorpay.orders.fetchPayments(orderId) as {
      items?: Array<{ status?: string; amount?: number; currency?: string }>
    }
    const live = (res.items ?? []).find(p =>
      (p.status === 'captured' || p.status === 'authorized') &&
      p.currency === 'INR' && p.amount === intent.amount)

    if (live) {
      // Money exists, registration does not — yet. The webhook is the backstop.
      return NextResponse.json({ state: 'captured_unsettled', canRetry: false })
    }
    // Nothing captured and nothing authorized: the attendee may pay THIS order. The client
    // reopens checkout on the same orderId rather than creating a second one.
    return NextResponse.json({ state: 'awaiting_payment', canRetry: true })
  } catch (err) {
    // FAIL-CLOSED. "We could not ask Razorpay" must never be reported as "no payment
    // exists" — that inference is precisely what produces a double charge.
    captureFinancialError(err, { scope: 'payment-status.fetch_payments_failed', detail: 'fail-closed → unknown', orderId })
    return NextResponse.json({ state: 'unknown', canRetry: false })
  }
}
