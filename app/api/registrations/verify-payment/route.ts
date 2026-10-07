// POST /api/registrations/verify-payment
//
// Security model:
//   1. HMAC-SHA256 signature verified with RAZORPAY_KEY_SECRET using
//      crypto.timingSafeEqual before ANY action (H1).
//   2. All registration data loaded from the payment intent (Firestore) — never
//      from the request body.  Client only sends the three Razorpay IDs.
//   3. Registration, counter increment, claim docs, and payment intent update
//      happen in ONE Firestore transaction — fully atomic.  Idempotency check
//      inside the transaction prevents duplicates on retry (H2).
//   4. If capacity is exceeded or registration fails after payment is captured,
//      a Razorpay refund is triggered automatically and logged (M2).

import { NextRequest, NextResponse }  from 'next/server'
import { adminAuth }                  from '@/lib/firebase/admin'
import { captureFinancialError }      from '@/lib/monitoring/sentry'
import { getPaymentIntent }           from '@/lib/firebase/firestore/paymentIntents'
import { resolvePaymentProvider, type PaymentProvider } from '@/lib/payments/providers'
import { getClientIp }                   from '@/lib/rateLimit'
import { checkDistributedRateLimit }     from '@/lib/rateLimit/redis'
// RD-PAY-P0-4 — THE one settlement, shared with the payment.captured webhook and the
// reconciliation sweep. Everything from the gate check through the post-commit side effects
// lives there, so all three paths write an identical registration.
import { settleCapturedRegistration } from '@/lib/payments/settleCapturedRegistration'

// ─── Request / response shapes ────────────────────────────────────────────────

interface VerifyBody {
  razorpay_order_id:   string
  razorpay_payment_id: string
  razorpay_signature:  string
}

export interface VerifyPaymentResponse {
  success:         boolean
  registrationId?: string
  error?:          string
  reason?:         string
}

// ─── Signature verification ────────────────────────────────────────────────────

// H1: Reject malformed signatures before comparison to prevent length-extension
//     attacks and avoid panics inside timingSafeEqual.
//     HMAC-SHA256 is always 32 bytes = 64 lowercase hex chars.

// RD-PAYMENT-PROVIDER-CONTRACT-04 — the HMAC implementation moved into the Razorpay
// adapter unchanged (same HEX_64 pre-check, same raw-Buffer digest, same timingSafeEqual).
// The route no longer knows how a signature is built, only that the provider vouched for it.
async function verifyCheckoutSignature(
  provider:  PaymentProvider,
  orderId:   string,
  paymentId: string,
  signature: string,
): Promise<boolean> {
  return resolvePaymentProvider(provider).verifyCheckoutSignature({
    providerOrderId:   orderId,
    providerPaymentId: paymentId,
    signature,
  })
}

// RD-PAY-P0-4: the local FailedRefundContext / InviteCodeError / triggerRefund helpers
// moved into settleCapturedRegistration alongside the settlement they served, so the
// refund-on-refusal policy has exactly ONE implementation shared by this route, the
// payment.captured webhook and the reconciliation sweep.

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<VerifyPaymentResponse>> {
  // ── 0. Rate limit: 20 verifications per 10 minutes per IP (distributed) ───
  //     Fail-CLOSED: a Redis outage must not open payment verification to abuse.
  const ip = getClientIp(req)
  const rl = await checkDistributedRateLimit({ key: `verify-payment:${ip}`, limit: 20, windowSeconds: 10 * 60 })
  if (!rl.allowed) {
    return NextResponse.json(
      { success: false, error: 'Too many requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '20',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── 1. Optional auth (uid used for registration if intent has no uid) ──────
  let uid: string | undefined
  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (bearerToken) {
    try {
      const decoded = await adminAuth.verifyIdToken(bearerToken)
      uid = decoded.uid
    } catch { /* fall through */ }
  }

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let body: VerifyBody
  try {
    body = (await req.json()) as VerifyBody
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return NextResponse.json({ success: false, error: 'Missing payment parameters' }, { status: 400 })
  }

  // ── 3. H1: Verify HMAC-SHA256 signature with timing-safe comparison ────────
  //
  // Verified as RAZORPAY, deliberately, and BEFORE the intent is loaded.
  //
  // This endpoint's request shape IS Razorpay's — `razorpay_order_id`, `razorpay_payment_id`,
  // `razorpay_signature` are that gateway's field names, so a request arriving here is a
  // Razorpay checkout callback by definition. Cashfree gets its own verify route, exactly as
  // it gets its own webhook route (a shared endpoint would mean one provider's signature
  // check could be reached with another's body).
  //
  // The ordering is also deliberate and unchanged: a forged request is rejected before it
  // can cause a Firestore read. Taking the provider from the intent would require loading
  // the intent first, i.e. reading the database on unauthenticated input. The intent's own
  // provider is cross-checked immediately after it loads, below.
  if (!await verifyCheckoutSignature('razorpay', razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
    return NextResponse.json(
      { success: false, error: 'Payment verification failed.', reason: 'INVALID_SIGNATURE' },
      { status: 400 },
    )
  }

  // ── 4. Load payment intent (authoritative data from Firestore) ─────────────
  const intent = await getPaymentIntent(razorpay_order_id)
  if (!intent) {
    captureFinancialError('intent_not_found', { scope: 'verify-payment.intent_not_found', orderId: razorpay_order_id })
    return NextResponse.json(
      { success: false, error: 'Payment record not found.', reason: 'INTENT_NOT_FOUND' },
      { status: 404 },
    )
  }

  // ── 4a. Provider cross-check ───────────────────────────────────────────────
  // The signature above proved a RAZORPAY signature over this order. If the stored intent
  // says the order belongs to a different gateway, the two disagree about where the money
  // is and nothing here may settle it. Unreachable today (Razorpay is the only enabled
  // provider); it exists so that adding one cannot make this route settle the wrong order.
  if (intent.provider !== 'razorpay') {
    captureFinancialError('provider_mismatch', {
      scope: 'verify-payment.provider_mismatch',
      orderId: razorpay_order_id, intentProvider: intent.provider,
    })
    return NextResponse.json(
      { success: false, error: 'Payment record does not match this payment method.', reason: 'PROVIDER_MISMATCH' },
      { status: 409 },
    )
  }

  // ── 4b. Terminal-state guard (mirrors the webhook's registration_failed skip) ─
  // Once an intent has been marked registration_failed OR a refund has been
  // initiated (refundId/refundStatus present), it is TERMINAL: the payment was
  // already refunded (or is being refunded), so re-submitting the still-valid
  // Razorpay signature must NEVER create a registration, credit a wallet, or
  // trigger a second refund — even if the original blocking condition (gate /
  // capacity / duplicate) has since cleared. Without this, a refunded payment
  // could be converted into a confirmed registration + organizer credit on retry.
  if (
    intent.status === 'registration_failed' ||
    intent.refundId !== undefined ||
    intent.refundStatus !== undefined
  ) {
    console.warn('[verify-payment] Intent is terminal (failed/refunded) — refusing:', {
      orderId:      razorpay_order_id,
      status:       intent.status,
      refundStatus: intent.refundStatus,
    })
    return NextResponse.json(
      {
        success: false,
        reason:  'PAYMENT_REFUNDED',
        // RD-FIN-01 · NOT "refunded": nothing refunds automatically any more. A terminal intent is
        // a failed attempt or a payment held for review — the money is safe and is reviewed.
        error:   'This payment could not complete your registration automatically and is being reviewed. Please do not pay again — if it cannot be honoured it will be refunded in full.',
      },
      { status: 409 },
    )
  }

  // ── 5–8. RD-PAY-P0-4: settle through THE ONE shared settlement ─────────────
  //
  // Everything from the gate check to the post-commit side effects moved to
  // settleCapturedRegistration(), which the payment.captured webhook and the reconciliation
  // sweep also call. Before this, the browser path and the two recovery paths wrote
  // DIFFERENT registrations for the same paid attendee — recovery dropped the coupon fields,
  // never consumed the coupon, skipped the coupon cap and the invite re-validation, and
  // counted gross revenue instead of the ticket base.
  //
  // Nothing about THIS route's contract changed: the same reasons, the same messages and the
  // same status codes are returned below, now mapped from the shared outcome.
  const outcome = await settleCapturedRegistration({
    orderId:   razorpay_order_id,
    paymentId: razorpay_payment_id,
    intent,
    source:    'verify',
    // An attendee who signed in after creating the order still gets it linked to them.
    ...(uid ? { uidOverride: uid } : {}),
  })

  if (outcome.kind === 'settled' || outcome.kind === 'already_settled') {
    return NextResponse.json({ success: true, registrationId: outcome.registrationId })
  }

  // RD-PAY-DUP-HOLD — a duplicate is refused WITHOUT an automatic refund, so this must not
  // promise one. The payment is held for manual review; saying "a refund has been initiated"
  // here would be a false statement to someone who has actually been charged.
  if (outcome.kind === 'held') {
    // RD-PAYMENT-REFUND-AUTHORITY-02 — every refusal now lands here, not just duplicates.
    //
    // Each message names the real reason and then says the same true thing: the payment was
    // received and a person will deal with it. None of them promises a refund, because
    // nothing automatic issues one any more. Promising money back and then not sending it is
    // worse than the refusal itself.
    const held: Record<string, string> = {
      DUPLICATE_EMAIL:     'A registration with this email address already exists for this event.',
      DUPLICATE_MOBILE:    'A registration with this mobile number already exists for this event.',
      EVENT_CAPACITY_FULL: 'This event became full before your registration could be completed.',
      PASS_CAPACITY_FULL:  'This pass sold out before your registration could be completed.',
      PASS_NOT_AVAILABLE:  'This pass is no longer available.',
      COUPON_EXHAUSTED:    'The coupon reached its usage limit before your registration could be completed.',
      INVITE_CODE_INVALID: 'Registration is not permitted for this event.',
      ticket_code_exhausted: 'Your registration could not be assigned a ticket code.',
    }
    const why = held[outcome.reason]
      ?? (outcome.gateBlocked ? 'Registration for this event is no longer open.' : 'Your registration could not be completed.')

    return NextResponse.json(
      {
        success: false,
        reason:  outcome.reason,
        error:   `${why} Your payment has been received and is under review — our team will contact you shortly. Please do not pay again.`,
      },
      { status: 409 },
    )
  }

  if (outcome.kind === 'deferred') {
    // The intent went terminal between the guard above and settlement, or the transaction
    // could not be completed. Nothing was written and nothing was refunded here.
    return NextResponse.json(
      { success: false, error: 'Payment could not be verified right now. Please wait a moment — do not pay again.' },
      { status: 503 },
    )
  }

  // Unreachable: settled / already_settled / held / deferred are the only outcomes, and
  // each returns above. Kept as an explicit, honest fallback rather than a throw — if a
  // new outcome is ever added, an attendee who has been charged still gets a true sentence
  // instead of a 500 with no explanation.
  return NextResponse.json(
    {
      success: false,
      error:   `Your payment has been received but the registration could not be completed. It is under review — our team will contact you shortly. Please do not pay again.`,
    },
    { status: 409 },
  )
}
