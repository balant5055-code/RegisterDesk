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
import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminAuth, adminDb }         from '@/lib/firebase/admin'
import {
  getPaymentIntent,
  markPaymentIntentFailed,
  updatePaymentIntentRefund,
} from '@/lib/firebase/firestore/paymentIntents'
import {
  generateTicketCode,
  TicketCodeCollisionError,
}                                     from '@/lib/registrations/ticketCode'
import { buildCounterIncrement }      from '@/lib/firebase/firestore/registrationCounters'
import { checkRegistrationGate }      from '@/lib/registrations/gate'
import {
  CapacityExceededError,
  DuplicateRegistrationError,
}                                     from '@/lib/firebase/firestore/registrations'
import { razorpay, RAZORPAY_KEY_SECRET } from '@/lib/razorpay/client'  // C1: throws if absent
import { checkRateLimit, getClientIp }   from '@/lib/rateLimit'
import type { PaymentIntentRecord }   from '@/lib/firebase/firestore/paymentIntents'

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

// ─── Refund helper ─────────────────────────────────────────────────────────────

// M2: Trigger a full automatic refund and record the outcome.
async function triggerRefund(
  orderId:   string,
  paymentId: string,
  amount:    number,
  reason:    string,
): Promise<void> {
  try {
    const refund = await razorpay.payments.refund(paymentId, {
      amount,
      speed:   'optimum',
      notes:   { reason, orderId },
      receipt: `refund_${orderId}`.slice(0, 40),
    })
    await updatePaymentIntentRefund(orderId, refund.id, refund.status, amount)
    console.log('[verify-payment] Refund initiated:', {
      orderId, paymentId, refundId: refund.id, status: refund.status, amount,
    })
  } catch (refundErr) {
    console.error('[verify-payment] Refund API call failed — manual refund required:', {
      orderId, paymentId, amount, reason, refundErr,
    })
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
): Promise<NextResponse<VerifyPaymentResponse>> {
  // ── 0. Rate limit: 20 verifications per 10 minutes per IP ─────────────────
  const ip = getClientIp(req)
  const rl = checkRateLimit(ip, 'verify-payment', 20, 10 * 60 * 1000)
  if (rl.limited) {
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
    console.error('[verify-payment] Intent not found for orderId:', razorpay_order_id)
    return NextResponse.json(
      { success: false, error: 'Payment record not found.', reason: 'INTENT_NOT_FOUND' },
      { status: 404 },
    )
  }

  // ── 5. Gate check (capacity may have changed since order was created) ───────
  const gate = await checkRegistrationGate(intent.eventSlug, intent.passId)
  if (!gate.allowed) {
    await markPaymentIntentFailed(razorpay_order_id, gate.reason)
    console.error('[verify-payment] Gate blocked after payment — triggering refund:', {
      orderId:   razorpay_order_id,
      paymentId: razorpay_payment_id,
      reason:    gate.reason,
      email:     intent.attendee.email,
    })
    await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, `gate_blocked:${gate.reason}`)
    return NextResponse.json(
      {
        success: false,
        reason:  gate.reason,
        error:   'Payment received but registration is no longer available. A full refund has been initiated and will appear within 5–7 business days.',
      },
      { status: 409 },
    )
  }

  // ── 6. H2: Claim doc refs (computed from intent before the transaction) ─────
  const normEmail = intent.attendee.email  // already normalised in create-order
  const normPhone = intent.attendee.phone

  const intentRef  = adminDb.collection('paymentIntents').doc(razorpay_order_id)
  const eventRef   = adminDb.collection('events').doc(intent.eventSlug)
  const counterRef = adminDb.collection('registrationCounters').doc(intent.eventSlug)
  const regRef     = adminDb.collection('registrations').doc(crypto.randomUUID())

  const emailClaimRef = adminDb.collection('registrationClaims')
    .doc(`${intent.eventSlug}_email_${normEmail}`)
  const phoneClaimRef = normPhone
    ? adminDb.collection('registrationClaims')
        .doc(`${intent.eventSlug}_phone_${normPhone}`)
    : null

  const registrationId = regRef.id

  // ── 7. Atomic transaction: idempotency + capacity + duplicate + write ───────
  // F1: retry loop — on the extremely rare ticket code collision, generate a new
  //     code and retry.  All other errors are handled immediately (no retry).
  let finalRegistrationId!: string

  for (let attempt = 0; attempt < 5; attempt++) {
    const ticketCode         = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    try {
      finalRegistrationId = await adminDb.runTransaction(async txn => {
        // Phase 1: read payment intent — fast idempotency exit before other reads
        const intentSnap = await txn.get(intentRef)
        const intentData = intentSnap.data() as PaymentIntentRecord

        if (intentData.status === 'paid' && intentData.registrationId) {
          return intentData.registrationId  // already processed — no new code needed
        }

        // Phase 2: read remaining docs in parallel (includes ticket code claim)
        const [eventSnap, counterSnap, emailClaimSnap, ticketClaimSnap] = await Promise.all([
          txn.get(eventRef),
          txn.get(counterRef),
          txn.get(emailClaimRef),
          txn.get(ticketCodeClaimRef),  // F1
        ])
        const phoneClaimSnap = phoneClaimRef ? await txn.get(phoneClaimRef) : null

        const eventData   = eventSnap.data() as Record<string, unknown> | undefined
        const counterData = counterSnap.exists
          ? counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
          : null

        // Extract registration rules from the event document
        const regForm  = eventData?.registrationForm as Record<string, unknown> | undefined
        const regRules = regForm?.registrationRules as
          { limitPerEmail?: boolean; limitPerMobile?: boolean } | undefined

        // F1: ticket code collision — outer loop retries with a new code
        if (ticketClaimSnap.exists) throw new TicketCodeCollisionError()

        // H2: Duplicate check inside transaction — prevents race condition where
        //     two payments complete simultaneously with the same email/phone.
        if (regRules?.limitPerEmail && emailClaimSnap.exists) {
          throw new DuplicateRegistrationError('DUPLICATE_EMAIL')
        }
        if (regRules?.limitPerMobile && phoneClaimSnap?.exists) {
          throw new DuplicateRegistrationError('DUPLICATE_MOBILE')
        }

        // Capacity double-check inside the transaction (closes TOCTOU race)
        const eventCapacity = (eventData?.totalCapacity as number | null | undefined) ?? null
        const totalCount    = counterData?.totalCount ?? 0
        const passCount     = (counterData?.passCounts ?? {})[intent.passId] ?? 0

        if (eventCapacity !== null && totalCount >= eventCapacity) {
          throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        }
        if (intent.passCapacity !== null && passCount >= intent.passCapacity) {
          throw new CapacityExceededError('PASS_CAPACITY_FULL')
        }

        const regDoc = {
          id:              registrationId,
          eventSlug:       intent.eventSlug,
          passId:          intent.passId,
          passName:        intent.passName,
          eventName:       intent.eventName,
          organizerUid:    intent.organizerUid,
          attendee:        intent.attendee,
          status:          'confirmed',
          paymentStatus:   'paid',
          amount:          intent.amount,           // paise — from payment intent, never from client
          razorpayOrderId: razorpay_order_id,
          paymentId:       razorpay_payment_id,
          ticketCode,
          registeredAt:    FieldValue.serverTimestamp(),
          updatedAt:       FieldValue.serverTimestamp(),
          ...(uid ?? intent.uid ? { uid: uid ?? intent.uid } : {}),
        }

        txn.set(regRef, regDoc)
        txn.set(counterRef, buildCounterIncrement(intent.eventSlug, intent.passId), { merge: true })
        txn.update(intentRef, {
          status:         'paid',
          registrationId,
          paymentId:      razorpay_payment_id,
          updatedAt:      FieldValue.serverTimestamp(),
        })

        // F1: claim ticket code atomically with the registration
        txn.set(ticketCodeClaimRef, {
          registrationId,
          eventSlug: intent.eventSlug,
          createdAt: FieldValue.serverTimestamp(),
        })

        // H2: write claim docs atomically — prevents future duplicates
        if (regRules?.limitPerEmail) {
          txn.set(emailClaimRef, {
            registrationId,
            eventSlug: intent.eventSlug,
            email:     normEmail,
            createdAt: FieldValue.serverTimestamp(),
          })
        }
        if (regRules?.limitPerMobile && phoneClaimRef && normPhone) {
          txn.set(phoneClaimRef, {
            registrationId,
            eventSlug: intent.eventSlug,
            phone:     normPhone,
            createdAt: FieldValue.serverTimestamp(),
          })
        }

        return registrationId
      })
      break  // transaction succeeded — exit retry loop

    } catch (err) {
      if (err instanceof TicketCodeCollisionError) {
        if (attempt < 4) continue  // generate new code, retry
        console.error('[verify-payment] Ticket code collision after 5 attempts:', {
          orderId: razorpay_order_id,
        })
        await markPaymentIntentFailed(razorpay_order_id, 'ticket_code_exhausted')
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, 'ticket_code_exhausted')
        return NextResponse.json(
          { success: false, error: 'Registration could not be completed. Please try again or contact support.' },
          { status: 500 },
        )
      }

      if (err instanceof DuplicateRegistrationError) {
        // A concurrent registration already claimed this email/phone.
        // Trigger refund — user paid but cannot register due to duplicate constraint.
        console.error('[verify-payment] Duplicate after payment — triggering refund:', {
          orderId:   razorpay_order_id,
          paymentId: razorpay_payment_id,
          reason:    err.reason,
          email:     intent.attendee.email,
          amount:    intent.amount,
        })
        await markPaymentIntentFailed(razorpay_order_id, err.reason)
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, err.reason)
        return NextResponse.json(
          {
            success: false,
            reason:  err.reason,
            error:   err.reason === 'DUPLICATE_EMAIL'
              ? 'A registration with this email address already exists. A full refund has been initiated.'
              : 'A registration with this mobile number already exists. A full refund has been initiated.',
          },
          { status: 409 },
        )
      }

      if (err instanceof CapacityExceededError) {
        // M2: Payment captured but event now full — trigger automatic refund.
        console.error('[verify-payment] Capacity exceeded after payment — triggering refund:', {
          orderId:   razorpay_order_id,
          paymentId: razorpay_payment_id,
          reason:    err.reason,
          email:     intent.attendee.email,
          amount:    intent.amount,
        })
        await markPaymentIntentFailed(razorpay_order_id, err.reason)
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, err.reason)
        return NextResponse.json(
          {
            success: false,
            reason:  err.reason,
            error:   err.reason === 'EVENT_CAPACITY_FULL'
              ? 'Payment received but this event is now full. A full refund has been initiated and will appear within 5–7 business days.'
              : 'Payment received but this pass is now sold out. A full refund has been initiated and will appear within 5–7 business days.',
          },
          { status: 409 },
        )
      }

      // M2: Unexpected error — trigger refund and log for admin recovery.
      console.error('[verify-payment] Registration transaction failed after payment — triggering refund:', {
        orderId:   razorpay_order_id,
        paymentId: razorpay_payment_id,
        eventSlug: intent.eventSlug,
        passId:    intent.passId,
        email:     intent.attendee.email,
        amount:    intent.amount,
        err,
      })
      await markPaymentIntentFailed(razorpay_order_id, 'transaction_error')
      await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, 'transaction_error')
      return NextResponse.json(
        {
          success: false,
          error:   'Payment received but registration could not be completed. A full refund has been initiated and will appear within 5–7 business days.',
        },
        { status: 500 },
      )
    }
  }

  return NextResponse.json({ success: true, registrationId: finalRegistrationId })
}
