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
import { captureError, captureFinancialError } from '@/lib/monitoring/sentry'
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
  CouponExhaustedError,
}                                     from '@/lib/firebase/firestore/registrations'
import type { CouponDocument }        from '@/lib/coupons/types'
import { razorpay, RAZORPAY_KEY_SECRET } from '@/lib/razorpay/client'  // C1: throws if absent
import { getClientIp }                   from '@/lib/rateLimit'
import { checkDistributedRateLimit }     from '@/lib/rateLimit/redis'
import { sendConfirmationEmail }          from '@/lib/registrations/sendConfirmationEmail'
import { notifyPaymentReceived }          from '@/lib/notifications/inbox/notify'
import type { PaymentIntentRecord }   from '@/lib/firebase/firestore/paymentIntents'
import { calculateFee }               from '@/lib/fees/engine'
import { getFeePlanForOrganizer }      from '@/lib/billing/feeEngine'
import { resolveFeeConfig }           from '@/lib/fees/resolveFeeConfig'
import { recordPlatformTransactionAndCredit, type PlatformTransactionData } from '@/lib/firebase/firestore/platformTransactions'
import { recordRegistrationFinancialReconciliation }                         from '@/lib/payments/registrationReconciliation'
import { validateInviteCode }         from '@/app/api/registrations/validate-invite-code/route'

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

// ─── Refund helpers ────────────────────────────────────────────────────────────

// P0-2: Context passed to triggerRefund so failedRefunds records include event
// and attendee identifiers for admin triage. Mirrors RefundContext in
// /api/webhooks/razorpay/route.ts.
interface FailedRefundContext {
  eventSlug:       string
  attendeeEmail:   string
  registrationId?: string
}

// P0-1: Thrown inside the Firestore transaction when the invite code stored on the
// payment intent fails re-validation. Caught by the outer for-loop exactly like
// DuplicateRegistrationError and CapacityExceededError — triggers a refund.
class InviteCodeError extends Error {
  constructor(public readonly reason: string) {
    super(reason)
    this.name = 'InviteCodeError'
  }
}

// M2: Trigger a full automatic refund and record the outcome.
// P0-2: ctx is used to write a failedRefunds document when the Razorpay refund API
// call fails, so admin can trigger manual recovery from the dashboard.
async function triggerRefund(
  orderId:   string,
  paymentId: string,
  amount:    number,
  reason:    string,
  ctx:       FailedRefundContext,
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
    captureFinancialError(refundErr, { scope: 'verify-payment.refund_api_failed', detail: 'writing failedRefunds record', orderId, paymentId, amount, reason })
    // P0-2: Write recovery record visible in the admin failed-refunds dashboard.
    // Mirrors the identical pattern in /api/webhooks/razorpay/route.ts:98-111.
    adminDb.collection('failedRefunds').add({
      orderId,
      paymentId,
      amountPaise:    amount,
      reason,
      eventSlug:      ctx.eventSlug,
      attendeeEmail:  ctx.attendeeEmail,
      registrationId: ctx.registrationId ?? null,
      status:         'open',
      createdAt:      FieldValue.serverTimestamp(),
    }).catch(e => captureFinancialError(e, { scope: 'verify-payment.failed_refund_persist_failed', detail: 'CRITICAL: could not write failedRefunds record', orderId, paymentId }))
  }
}

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

  // P0-2: Built once after intent is confirmed; reused by every triggerRefund call
  // so all failedRefunds records include event/attendee context for admin triage.
  const refundCtx: FailedRefundContext = {
    eventSlug:    intent.eventSlug,
    attendeeEmail: intent.attendee.email,
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

  // ── 5. Gate check (capacity may have changed since order was created) ───────
  const gate = await checkRegistrationGate(intent.eventSlug, intent.passId)
  if (!gate.allowed) {
    await markPaymentIntentFailed(razorpay_order_id, gate.reason)
    captureFinancialError('gate_blocked_after_payment', { scope: 'verify-payment.gate_blocked', orderId: razorpay_order_id, paymentId: razorpay_payment_id, reason: gate.reason })
    await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, `gate_blocked:${gate.reason}`, refundCtx)
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

    // Reset per-iteration: tracks whether the transaction created a new registration
    // (false when the idempotency path fires — email already sent on the first call).
    let txnWasNoOp = false
    let capturedRawDetails: Record<string, unknown> = {}

    try {
      finalRegistrationId = await adminDb.runTransaction(async txn => {
        // Phase 1: read payment intent — fast idempotency exit before other reads
        const intentSnap = await txn.get(intentRef)
        const intentData = intentSnap.data() as PaymentIntentRecord

        if (intentData.status === 'paid' && intentData.registrationId) {
          txnWasNoOp = true
          return intentData.registrationId  // already processed — no new code needed
        }

        // Coupon doc ref — read inside the transaction so the usage cap is
        // enforced atomically; concurrent paid redemptions serialize on it.
        const couponRef = (intent.couponDocId && intent.couponCode)
          ? adminDb.collection('events').doc(intent.eventSlug)
              .collection('coupons').doc(intent.couponDocId)
          : null

        // Phase 2: read remaining docs in parallel (includes ticket code claim).
        // GA-7C P1-4: the base counter is NOT read here — it is read conditionally in
        // the capacity block below, only when a capacity limit gates this registration,
        // so uncapped paid settlements don't abort each other on the counter.
        const [eventSnap, emailClaimSnap, ticketClaimSnap] = await Promise.all([
          txn.get(eventRef),
          txn.get(emailClaimRef),
          txn.get(ticketCodeClaimRef),  // F1
        ])
        const phoneClaimSnap = phoneClaimRef ? await txn.get(phoneClaimRef) : null
        const couponSnap     = couponRef     ? await txn.get(couponRef)     : null

        const eventData   = eventSnap.data() as Record<string, unknown> | undefined
        // Capture event details for the confirmation email sent after the transaction.
        capturedRawDetails = (eventData?.eventDetails ?? {}) as Record<string, unknown>

        // P0-1: Re-validate invite code using the live event accessControl.
        // intentData.inviteCode was stored by create-order after initial validation.
        // validateInviteCode returns valid:true for events that don't require invite
        // codes, so this is a no-op for non-invite-only events. For events where
        // the payment intent pre-dates this fix (inviteCode === undefined), providing
        // '' will cause rejection when ac.type === 'invite_code' — correct behaviour.
        const inviteValidation = validateInviteCode(
          eventData?.accessControl,
          intentData.inviteCode ?? '',
        )
        if (!inviteValidation.valid) throw new InviteCodeError('INVITE_CODE_INVALID')

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

        // Capacity double-check inside the transaction (closes TOCTOU race).
        // P1-4: pass capacity is re-read from the live event document so that any
        // reduction the organiser made between order creation and payment settlement
        // is always honoured. intent.passCapacity is intentionally not used here —
        // it was captured at order creation and may be stale.
        const rawPricing       = eventData?.pricing as Record<string, unknown> | null | undefined
        const livePasses       = Array.isArray(rawPricing?.passes)
          ? (rawPricing!.passes as Record<string, unknown>[])
          : []
        const livePass         = livePasses.find(p => p.id === intent.passId)

        // Pass was deleted or deactivated after order creation — attendee cannot register.
        if (!livePass) throw new CapacityExceededError('PASS_NOT_AVAILABLE')

        const livePassCapacity = livePass.unlimited === true
          ? null
          : typeof livePass.quantity === 'number' ? livePass.quantity : null

        const eventCapacity = (eventData?.totalCapacity as number | null | undefined) ?? null

        // GA-7C P1-4: read the base counter only when a capacity limit actually gates
        // this paid registration (same rationale as createRegistration). Uncapped paid
        // settlements skip the read, so concurrent commits don't abort on the counter;
        // the increment WRITE below stays a blind, commutative FieldValue.increment.
        // Capped events read + gate here, so overselling remains impossible.
        let totalCount = 0, passCount = 0
        if (eventCapacity !== null || livePassCapacity !== null) {
          const counterSnap = await txn.get(counterRef)
          const counterData = counterSnap.exists
            ? counterSnap.data() as { totalCount?: number; passCounts?: Record<string, number> }
            : null
          totalCount = counterData?.totalCount ?? 0
          passCount  = (counterData?.passCounts ?? {})[intent.passId] ?? 0
        }

        if (eventCapacity !== null && totalCount >= eventCapacity) {
          throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        }
        if (livePassCapacity !== null && passCount >= livePassCapacity) {
          throw new CapacityExceededError('PASS_CAPACITY_FULL')
        }

        // Coupon usage cap — re-checked inside the transaction (couponRef is in
        // the read set). The loser of a concurrent race for the last use is
        // rejected here and refunded below, so currentUses never exceeds maxUses.
        if (couponRef && couponSnap?.exists) {
          const couponData = couponSnap.data() as CouponDocument
          if (typeof couponData.maxUses === 'number' && couponData.currentUses >= couponData.maxUses) {
            throw new CouponExhaustedError()
          }
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
          // Coupon fields — sourced from the payment intent (set at order creation)
          ...(intent.couponCode ? {
            couponCode:     intent.couponCode,
            discountAmount: intent.discountAmount,
            originalAmount: intent.originalAmount,
          } : {}),
        }

        // Atomically increment coupon currentUses inside the registration
        // transaction (cap re-checked above; couponRef is in the read set).
        if (couponRef) {
          txn.update(couponRef, {
            currentUses: FieldValue.increment(1),
            updatedAt:   FieldValue.serverTimestamp(),
          })
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

      // Only run post-transaction work for a new registration.
      // txnWasNoOp is true when the idempotency path fired (intent already 'paid');
      // both financial ops and the email were handled on the first call.
      if (!txnWasNoOp) {
        // P1-6: Financial operations FIRST — wallet credit and platform ledger must
        // be committed before email delivery begins. Previously email was awaited
        // first, so a Lambda timeout or crash during email delivery left the wallet
        // un-credited with no recovery path. Moving ledger ops here shrinks the
        // crash window to the Firestore write latency (~ms) rather than the email
        // provider round-trip (~1-3 s).
        //
        // Idempotency is preserved by txnWasNoOp: this block runs exactly once per
        // new registration. A client retry after the transaction commits finds the
        // intent already 'paid', sets txnWasNoOp = true, and skips this block.
        if (intent.amount > 0) {
          const feePlan = await getFeePlanForOrganizer(intent.organizerUid)
          const feeConfig = await resolveFeeConfig('event_registration', feePlan.planTier)
          const feeResult = calculateFee({
            transactionType:  'event_registration',
            grossAmountPaise: intent.amount,
            feeModel:         'organizer_pays',
            config:           feeConfig,
          })
          const ledger: PlatformTransactionData = {
            id:                      `ptx_${finalRegistrationId}`,
            type:                    'event_registration',
            category:                'ticketed',
            organizerUid:            intent.organizerUid,
            entityId:                intent.eventSlug,
            entityType:              'event',
            sourceId:                finalRegistrationId,
            sourceType:              'registration',
            payerName:               intent.attendee.name,
            payerEmail:              intent.attendee.email,
            grossAmountPaise:        intent.amount,
            platformFeeBasePaise:    feeResult.platformFeeBasePaise,
            platformFeeGstPaise:     feeResult.platformFeeGstPaise,
            platformFeeTotalPaise:   feeResult.platformFeeTotalPaise,
            gatewayFeeEstimatePaise: feeResult.gatewayFeeEstimatePaise,
            netSettlementPaise:      feeResult.netSettlementPaise,
            feeModel:                'organizer_pays',
            planTier:                feePlan.planTier,
            feeConfigId:             feePlan.feeConfigId,
            currency:                'INR',
            gateway:                 'razorpay',
            gatewayPaymentId:        razorpay_payment_id,
            gatewayOrderId:          razorpay_order_id,
          }
          const credit = {
            organizerUid:       intent.organizerUid,
            grossAmountPaise:   intent.amount,
            feesTotalPaise:     feeResult.platformFeeTotalPaise + feeResult.gatewayFeeEstimatePaise,
            netSettlementPaise: feeResult.netSettlementPaise,
          }
          // POST-COMMIT: the registration is already durable. The atomic
          // ledger+credit is idempotent; if it throws (transient Firestore
          // error) we MUST NOT refund or fail the intent — instead persist a
          // reconciliation record for out-of-band retry and continue to success.
          try {
            await recordPlatformTransactionAndCredit(ledger, credit)
          } catch (financialErr) {
            await recordRegistrationFinancialReconciliation({
              registrationId: finalRegistrationId,
              orderId:        razorpay_order_id,
              paymentId:      razorpay_payment_id,
              ledger,
              credit,
              error:          financialErr instanceof Error ? financialErr.message : 'financial_side_effect_failed',
            })
          }
        }

        // Email AFTER financial ops — wallet and ledger are already committed at
        // this point. Wrapped in try/catch so a delivery failure cannot propagate
        // to the outer error handler and trigger an unintended refund.
        try {
          await sendConfirmationEmail({
            registrationId: finalRegistrationId,
            ticketCode,
            attendeeName:   intent.attendee.name,
            attendeeEmail:  intent.attendee.email,
            eventName:      intent.eventName,
            passName:       intent.passName,
            rawDetails:     capturedRawDetails,
            organizerUid:   intent.organizerUid,
            eventSlug:      intent.eventSlug,
            amountPaid:     intent.amount,
          })
        } catch (emailErr) {
          // Registration and financial state are already committed — this is
          // non-fatal. sendConfirmationEmail has its own internal catch, so this
          // outer catch handles any unexpected throws from the outer function body.
          captureError(emailErr, { scope: 'verify-payment.confirmation_email_failed', detail: 'non-fatal', registrationId: finalRegistrationId })
        }

        // H.4.3: organizer Notification Center inbox (best-effort; deduped per registration).
        void notifyPaymentReceived({
          workspaceUid:   intent.organizerUid,
          registrationId: finalRegistrationId,
          eventName:      intent.eventName,
          amountPaise:    intent.amount,
          attendeeName:   intent.attendee.name,
        })
      }

      break  // transaction succeeded — exit retry loop

    } catch (err) {
      if (err instanceof TicketCodeCollisionError) {
        if (attempt < 4) continue  // generate new code, retry
        captureFinancialError('ticket_code_exhausted', { scope: 'verify-payment.ticket_collision', orderId: razorpay_order_id, paymentId: razorpay_payment_id })
        await markPaymentIntentFailed(razorpay_order_id, 'ticket_code_exhausted')
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, 'ticket_code_exhausted', refundCtx)
        return NextResponse.json(
          { success: false, error: 'Registration could not be completed. Please try again or contact support.' },
          { status: 500 },
        )
      }

      if (err instanceof DuplicateRegistrationError) {
        // A concurrent registration already claimed this email/phone.
        // Trigger refund — user paid but cannot register due to duplicate constraint.
        captureFinancialError('duplicate_after_payment', { scope: 'verify-payment.duplicate_refund', orderId: razorpay_order_id, paymentId: razorpay_payment_id, reason: err.reason, amount: intent.amount })
        await markPaymentIntentFailed(razorpay_order_id, err.reason)
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, err.reason, refundCtx)
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
        captureFinancialError('capacity_exceeded_after_payment', { scope: 'verify-payment.capacity_refund', orderId: razorpay_order_id, paymentId: razorpay_payment_id, reason: err.reason, amount: intent.amount })
        await markPaymentIntentFailed(razorpay_order_id, err.reason)
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, err.reason, refundCtx)
        return NextResponse.json(
          {
            success: false,
            reason:  err.reason,
            error:   err.reason === 'EVENT_CAPACITY_FULL'
              ? 'Payment received but this event is now full. A full refund has been initiated and will appear within 5–7 business days.'
              : err.reason === 'PASS_NOT_AVAILABLE'
              ? 'Payment received but this pass is no longer available. A full refund has been initiated and will appear within 5–7 business days.'
              : 'Payment received but this pass is now sold out. A full refund has been initiated and will appear within 5–7 business days.',
          },
          { status: 409 },
        )
      }

      if (err instanceof CouponExhaustedError) {
        // Coupon usage limit reached after payment (a concurrent registration
        // consumed the last use between order creation and settlement).
        // Refuse + refund — the registration is not created and the coupon is
        // not incremented (the whole transaction rolled back).
        captureFinancialError('coupon_exhausted_after_payment', { scope: 'verify-payment.coupon_refund', orderId: razorpay_order_id, paymentId: razorpay_payment_id, amount: intent.amount })
        await markPaymentIntentFailed(razorpay_order_id, 'coupon_exhausted')
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, 'coupon_exhausted', refundCtx)
        return NextResponse.json(
          {
            success: false,
            reason:  'COUPON_EXHAUSTED',
            error:   'Payment received but the coupon reached its usage limit. A full refund has been initiated and will appear within 5–7 business days.',
          },
          { status: 409 },
        )
      }

      if (err instanceof InviteCodeError) {
        // P0-1: Invite code re-validation failed inside the transaction. Fires when an
        // order was created without invite code validation (pre-fix intents or direct
        // API calls that bypassed create-order). Registration is refused; refund issued.
        captureFinancialError('invite_invalid_after_payment', { scope: 'verify-payment.invite_refund', orderId: razorpay_order_id, paymentId: razorpay_payment_id, reason: err.reason, amount: intent.amount })
        await markPaymentIntentFailed(razorpay_order_id, err.reason)
        await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, err.reason, refundCtx)
        return NextResponse.json(
          {
            success: false,
            reason:  err.reason,
            error:   'Payment received but registration is not permitted for this event. A full refund has been initiated and will appear within 5–7 business days.',
          },
          { status: 403 },
        )
      }

      // M2: Unexpected error — trigger refund and alert for admin recovery.
      captureFinancialError(err, { scope: 'verify-payment.transaction_failed', orderId: razorpay_order_id, paymentId: razorpay_payment_id, eventSlug: intent.eventSlug, passId: intent.passId, amount: intent.amount })
      await markPaymentIntentFailed(razorpay_order_id, 'transaction_error')
      await triggerRefund(razorpay_order_id, razorpay_payment_id, intent.amount, 'transaction_error', refundCtx)
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
