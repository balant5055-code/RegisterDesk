// POST /api/webhooks/razorpay
//
// Recovery handler: Razorpay fires this webhook when a payment is captured.
// If the client never called verify-payment (crash, network failure, tab close),
// this handler creates the registration so the attendee is not lost.
//
// Security:
//   - Raw request body is read as text; HMAC-SHA256 is computed over it using
//     RAZORPAY_WEBHOOK_SECRET and compared with x-razorpay-signature via
//     crypto.timingSafeEqual (timing-safe, rejects malformed sigs first).
//   - Idempotency: payment intent status check ensures one registration per order.
//   - All registration data is loaded from Firestore (payment intent), never from
//     the webhook payload.

import crypto                         from 'crypto'
import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }                    from '@/lib/firebase/admin'
import {
  getPaymentIntent,
  markPaymentIntentFailed,
  updatePaymentIntentRefund,
} from '@/lib/firebase/firestore/paymentIntents'
import { creditWallet } from '@/lib/firebase/firestore/wallet'
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
import { razorpay }                   from '@/lib/razorpay/client'
import type { PaymentIntentRecord }   from '@/lib/firebase/firestore/paymentIntents'

// ─── Startup guard ────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET
if (!WEBHOOK_SECRET) {
  throw new Error(
    'RAZORPAY_WEBHOOK_SECRET must be set to receive Razorpay webhooks. ' +
    'Configure it in the Razorpay dashboard under Settings → Webhooks.',
  )
}

// ─── Signature verification ────────────────────────────────────────────────────

const HEX_64 = /^[0-9a-f]{64}$/

function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!HEX_64.test(signature)) return false

  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET!)
    .update(rawBody)
    .digest()

  const actual = Buffer.from(signature, 'hex')
  return crypto.timingSafeEqual(expected, actual)
}

// ─── Refund helper ─────────────────────────────────────────────────────────────

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
    console.log('[webhook/razorpay] Refund initiated:', {
      orderId, paymentId, refundId: refund.id, status: refund.status,
    })
  } catch (refundErr) {
    console.error('[webhook/razorpay] Refund API call failed — manual refund required:', {
      orderId, paymentId, amount, reason, refundErr,
    })
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body (required for HMAC computation) ──────────────────────
  const rawBody = await req.text()
  const signature = req.headers.get('x-razorpay-signature') ?? ''

  // ── 2. Verify webhook signature ────────────────────────────────────────────
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn('[webhook/razorpay] Invalid signature — rejecting')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // ── 3. Parse event payload ─────────────────────────────────────────────────
  let event: Record<string, unknown>
  try {
    event = JSON.parse(rawBody) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Only handle payment.captured — other events are acknowledged but ignored.
  const eventType = event.event as string | undefined
  if (eventType !== 'payment.captured') {
    return NextResponse.json({ received: true })
  }

  // ── 4. Extract identifiers from payload ────────────────────────────────────
  const payload    = event.payload as Record<string, unknown> | undefined
  const paymentObj = (payload?.payment as Record<string, unknown> | undefined)
    ?.entity as Record<string, unknown> | undefined

  const paymentId = paymentObj?.id as string | undefined
  const orderId   = paymentObj?.order_id as string | undefined

  if (!paymentId || !orderId) {
    console.error('[webhook/razorpay] Missing payment ID or order ID in payload:', { eventType, payload })
    return NextResponse.json({ error: 'Missing payment identifiers' }, { status: 400 })
  }

  // ── 5a. Check for wallet top-up order first ───────────────────────────────
  const topupSnap = await adminDb.collection('walletTopups').doc(orderId).get()
  if (topupSnap.exists) {
    const topup = topupSnap.data() as { uid: string; amountPaise: number; status: string }
    if (topup.status === 'credited') {
      return NextResponse.json({ received: true })  // already credited
    }
    await creditWallet(topup.uid, topup.amountPaise)
    await adminDb.collection('walletTopups').doc(orderId).update({
      status:    'credited',
      paymentId,
      updatedAt: FieldValue.serverTimestamp(),
    })
    console.log('[webhook/razorpay] Wallet credited via recovery:', { orderId, paymentId, uid: topup.uid, amountPaise: topup.amountPaise })
    return NextResponse.json({ received: true })
  }

  // ── 5. Load payment intent (source of truth — never trust webhook payload) ─
  const intent = await getPaymentIntent(orderId)
  if (!intent) {
    // Webhook for an order not created by this app — ignore safely.
    console.warn('[webhook/razorpay] No payment intent for orderId:', orderId)
    return NextResponse.json({ received: true })
  }

  // ── 6. Idempotency — skip if already successfully processed ───────────────
  if (intent.status === 'paid' && intent.registrationId) {
    console.log('[webhook/razorpay] Already processed — skipping:', {
      orderId, registrationId: intent.registrationId,
    })
    return NextResponse.json({ received: true })
  }

  if (intent.status === 'registration_failed') {
    console.warn('[webhook/razorpay] Intent already in failed state — skipping:', { orderId })
    return NextResponse.json({ received: true })
  }

  // ── 6.5. F5: Gate check — cancelled/postponed/full events must not receive ─
  //         recovered registrations
  const gate = await checkRegistrationGate(intent.eventSlug, intent.passId)
  if (!gate.allowed) {
    console.error('[webhook/razorpay] Gate blocked — triggering refund:', {
      orderId, paymentId, reason: gate.reason, email: intent.attendee.email,
    })
    await markPaymentIntentFailed(orderId, gate.reason)
    await triggerRefund(orderId, paymentId, intent.amount, `gate_blocked:${gate.reason}`)
    return NextResponse.json({ received: true })
  }

  // ── 7. Compute document refs and claim paths ───────────────────────────────
  const normEmail = intent.attendee.email
  const normPhone = intent.attendee.phone

  const intentRef  = adminDb.collection('paymentIntents').doc(orderId)
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

  // ── 8. F1: retry loop + atomic transaction: idempotency + duplicate + ───────
  //         capacity + ticket code claim + write
  for (let attempt = 0; attempt < 5; attempt++) {
    const ticketCode         = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    try {
      await adminDb.runTransaction(async txn => {
        // Phase 1: read intent for fast idempotency check
        const intentSnap = await txn.get(intentRef)
        const intentData = intentSnap.data() as PaymentIntentRecord

        if (intentData.status === 'paid' && intentData.registrationId) {
          return  // already processed — no-op
        }

        // Phase 2: read remaining docs (includes ticket code claim)
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

        const regForm  = eventData?.registrationForm as Record<string, unknown> | undefined
        const regRules = regForm?.registrationRules as
          { limitPerEmail?: boolean; limitPerMobile?: boolean } | undefined

        // F1: ticket code collision — outer loop retries with a new code
        if (ticketClaimSnap.exists) throw new TicketCodeCollisionError()

        // Duplicate check
        if (regRules?.limitPerEmail && emailClaimSnap.exists) {
          throw new DuplicateRegistrationError('DUPLICATE_EMAIL')
        }
        if (regRules?.limitPerMobile && phoneClaimSnap?.exists) {
          throw new DuplicateRegistrationError('DUPLICATE_MOBILE')
        }

        // Capacity check
        const eventCapacity = (eventData?.totalCapacity as number | null | undefined) ?? null
        const totalCount    = counterData?.totalCount ?? 0
        const passCount     = (counterData?.passCounts ?? {})[intent.passId] ?? 0

        if (eventCapacity !== null && totalCount >= eventCapacity) {
          throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        }
        if (intent.passCapacity !== null && passCount >= intent.passCapacity) {
          throw new CapacityExceededError('PASS_CAPACITY_FULL')
        }

        // Writes
        txn.set(regRef, {
          id:              registrationId,
          eventSlug:       intent.eventSlug,
          passId:          intent.passId,
          passName:        intent.passName,
          eventName:       intent.eventName,
          organizerUid:    intent.organizerUid,
          attendee:        intent.attendee,
          status:          'confirmed',
          paymentStatus:   'paid',
          amount:          intent.amount,
          razorpayOrderId: orderId,
          paymentId,
          ticketCode,
          recoveredByWebhook: true,
          registeredAt:    FieldValue.serverTimestamp(),
          updatedAt:       FieldValue.serverTimestamp(),
          ...(intent.uid ? { uid: intent.uid } : {}),
        })

        txn.set(counterRef, buildCounterIncrement(intent.eventSlug, intent.passId), { merge: true })
        txn.update(intentRef, {
          status:         'paid',
          registrationId,
          paymentId,
          updatedAt:      FieldValue.serverTimestamp(),
        })

        // F1: claim ticket code atomically with the registration
        txn.set(ticketCodeClaimRef, {
          registrationId,
          eventSlug: intent.eventSlug,
          createdAt: FieldValue.serverTimestamp(),
        })

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
      })

      console.log('[webhook/razorpay] Registration recovered:', {
        orderId, paymentId, registrationId, eventSlug: intent.eventSlug,
      })
      return NextResponse.json({ received: true })

    } catch (err) {
      if (err instanceof TicketCodeCollisionError) {
        if (attempt < 4) continue  // generate new code, retry
        console.error('[webhook/razorpay] Ticket code collision after 5 attempts:', { orderId, paymentId })
        await markPaymentIntentFailed(orderId, 'ticket_code_exhausted')
        await triggerRefund(orderId, paymentId, intent.amount, 'ticket_code_exhausted')
        return NextResponse.json({ received: true })
      }

      if (err instanceof DuplicateRegistrationError) {
        console.error('[webhook/razorpay] Duplicate after capture — triggering refund:', {
          orderId, paymentId, reason: err.reason, email: intent.attendee.email,
        })
        await markPaymentIntentFailed(orderId, err.reason)
        await triggerRefund(orderId, paymentId, intent.amount, err.reason)
        return NextResponse.json({ received: true })
      }

      if (err instanceof CapacityExceededError) {
        console.error('[webhook/razorpay] Capacity exceeded — triggering refund:', {
          orderId, paymentId, reason: err.reason, email: intent.attendee.email,
        })
        await markPaymentIntentFailed(orderId, err.reason)
        await triggerRefund(orderId, paymentId, intent.amount, err.reason)
        return NextResponse.json({ received: true })
      }

      console.error('[webhook/razorpay] Unexpected error — triggering refund:', {
        orderId, paymentId, eventSlug: intent.eventSlug, err,
      })
      await markPaymentIntentFailed(orderId, 'webhook_transaction_error')
      await triggerRefund(orderId, paymentId, intent.amount, 'webhook_transaction_error')
      return NextResponse.json({ received: true })
    }
  }

  // Unreachable: every loop iteration either returns or continues.
  return NextResponse.json({ received: true })
}
