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

import crypto                         from 'crypto'
import { NextRequest, NextResponse, after }  from 'next/server'
import { adminAuth }                  from '@/lib/firebase/admin'
import { captureFinancialError }      from '@/lib/monitoring/sentry'
import { getPaymentIntent }           from '@/lib/firebase/firestore/paymentIntents'
import { RAZORPAY_KEY_SECRET }        from '@/lib/razorpay/client'  // C1: throws if absent
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
const HEX_64 = /^[0-9a-f]{64}$/

function verifyRazorpaySignature(
  orderId:   string,
  paymentId: string,
  signature: string,
): boolean {
  if (!HEX_64.test(signature)) return false   // reject malformed before any crypto

  const expected = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest()                                  // raw Buffer — same length as actual

  const actual = Buffer.from(signature, 'hex') // always 32 bytes if regex passed

  return crypto.timingSafeEqual(expected, actual)
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
  if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
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
        error:   'This payment was refunded and cannot be used to register. If you were charged, the refund will appear within 5–7 business days.',
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
    // Post-commit only: the confirmation email leaves after this response is flushed, so a
    // slow email provider can never hold up the attendee's payment confirmation.
    defer: after,
  })

  if (outcome.kind === 'settled' || outcome.kind === 'already_settled') {
    return NextResponse.json({ success: true, registrationId: outcome.registrationId })
  }

  if (outcome.kind === 'deferred') {
    // The intent went terminal between the guard above and settlement, or the transaction
    // could not be completed. Nothing was written and nothing was refunded here.
    return NextResponse.json(
      { success: false, error: 'Payment could not be verified right now. Please wait a moment — do not pay again.' },
      { status: 503 },
    )
  }

  // Refused, and refunded in full by the shared settlement.
  const r = outcome.reason

  if (outcome.gateBlocked) {
    return NextResponse.json(
      {
        success: false,
        reason:  r,
        error:   'Payment received but registration is no longer available. A full refund has been initiated and will appear within 5–7 business days.',
      },
      { status: 409 },
    )
  }

  if (r === 'DUPLICATE_EMAIL' || r === 'DUPLICATE_MOBILE') {
    return NextResponse.json(
      {
        success: false,
        reason:  r,
        error:   r === 'DUPLICATE_EMAIL'
          ? 'A registration with this email address already exists. A full refund has been initiated.'
          : 'A registration with this mobile number already exists. A full refund has been initiated.',
      },
      { status: 409 },
    )
  }

  if (r === 'EVENT_CAPACITY_FULL' || r === 'PASS_CAPACITY_FULL' || r === 'PASS_NOT_AVAILABLE') {
    return NextResponse.json(
      {
        success: false,
        reason:  r,
        error:   r === 'EVENT_CAPACITY_FULL'
          ? 'Payment received but this event is now full. A full refund has been initiated and will appear within 5–7 business days.'
          : r === 'PASS_NOT_AVAILABLE'
          ? 'Payment received but this pass is no longer available. A full refund has been initiated and will appear within 5–7 business days.'
          : 'Payment received but this pass is now sold out. A full refund has been initiated and will appear within 5–7 business days.',
      },
      { status: 409 },
    )
  }

  if (r === 'COUPON_EXHAUSTED') {
    return NextResponse.json(
      {
        success: false,
        reason:  'COUPON_EXHAUSTED',
        error:   'Payment received but the coupon reached its usage limit. A full refund has been initiated and will appear within 5–7 business days.',
      },
      { status: 409 },
    )
  }

  if (r === 'INVITE_CODE_INVALID') {
    return NextResponse.json(
      {
        success: false,
        reason:  r,
        error:   'Payment received but registration is not permitted for this event. A full refund has been initiated and will appear within 5–7 business days.',
      },
      { status: 403 },
    )
  }

  if (r === 'ticket_code_exhausted') {
    return NextResponse.json(
      { success: false, error: 'Registration could not be completed. Please try again or contact support.' },
      { status: 500 },
    )
  }

  return NextResponse.json(
    {
      success: false,
      error:   'Payment received but registration could not be completed. A full refund has been initiated and will appear within 5–7 business days.',
    },
    { status: 500 },
  )
}
