// POST /api/webhooks/razorpay
//
// Registration and wallet recovery handler. Handles three event types:
//
//   payment.captured  — Creates the registration if verify-payment was never called
//                       (crash, network failure, tab close). Idempotent.
//   payment.failed    — Marks stale payment intents as failed so they don't accumulate.
//   refund.processed  — Syncs dashboard/chargeback refunds back to Firestore. Updates
//                       registration paymentStatus, reverses the platform ledger entry,
//                       and debits the organizer revenue wallet. Idempotent.
//
// Security:
//   - Raw request body is read as text; HMAC-SHA256 is computed over it using
//     RAZORPAY_WEBHOOK_SECRET and compared with x-razorpay-signature via
//     crypto.timingSafeEqual (timing-safe, rejects malformed sigs first).
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
import { atomicTopupCredit } from '@/lib/firebase/firestore/wallet'
import { recordWalletTopupReconciliation } from '@/lib/wallet/topupReconciliation'
import {
  generateTicketCode,
  TicketCodeCollisionError,
}                                     from '@/lib/registrations/ticketCode'
import { buildCounterIncrement }      from '@/lib/firebase/firestore/registrationCounters'
import { checkRegistrationGate }      from '@/lib/registrations/gate'
import {
  CapacityExceededError,
  DuplicateRegistrationError,
  writeAuditEntry,
}                                     from '@/lib/firebase/firestore/registrations'
import { razorpay }                   from '@/lib/razorpay/client'
import { sendConfirmationEmail }      from '@/lib/registrations/sendConfirmationEmail'
import { sendRefundEmail }            from '@/lib/registrations/sendRefundEmail'
import {
  reversePlatformTransactionAndDebit,
  recordPlatformTransactionAndCredit,
  type PlatformTransactionData,
}                                     from '@/lib/firebase/firestore/platformTransactions'
import { recordRegistrationFinancialReconciliation } from '@/lib/payments/registrationReconciliation'
import { calculateFee }               from '@/lib/fees/engine'
import { getFeePlanForOrganizer }      from '@/lib/billing/feeEngine'
import { resolveFeeConfig }           from '@/lib/fees/resolveFeeConfig'
import type { PaymentIntentRecord }   from '@/lib/firebase/firestore/paymentIntents'
import { flagSuspiciousPayment }      from '@/lib/payments/flagSuspicious'
import { captureFinancialError, captureWebhookError } from '@/lib/monitoring/sentry'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter } from '@/lib/licensing/schema'
import { getEffectiveLicenseDefinition } from '@/lib/licensing/resolveCatalog'
import { activateLicenseOrder, refundExhaustedCouponRemainder } from '@/lib/licensing/finalizeLicensePurchase'
import { releaseRegistrationSessions } from '@/lib/sessions/allocation'
import { RAZORPAY_WEBHOOK_SECRET }    from '@/lib/env'

// ─── Signature verification ────────────────────────────────────────────────────

const HEX_64 = /^[0-9a-f]{64}$/

function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  if (!HEX_64.test(signature)) return false

  const expected = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest()

  const actual = Buffer.from(signature, 'hex')
  return crypto.timingSafeEqual(expected, actual)
}

// ─── Refund context ────────────────────────────────────────────────────────────

interface RefundContext {
  eventSlug:      string
  attendeeEmail:  string
  registrationId?: string  // not available in gate-blocked case
}

// ─── Refund helper ─────────────────────────────────────────────────────────────

async function triggerRefund(
  orderId:   string,
  paymentId: string,
  amount:    number,
  reason:    string,
  ctx:       RefundContext,
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
    captureFinancialError(refundErr, { scope: 'razorpay.refund_api_failed', detail: 'writing failedRefunds record', orderId, paymentId, amount, reason })
    // Write a recovery record so the failure is detectable and actionable (H-2).
    // Never rely only on logs — this document is the signal for manual intervention.
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
    }).catch(e => captureFinancialError(e, { scope: 'razorpay.failed_refund_persist_failed', detail: 'CRITICAL: could not write failedRefunds record', orderId, paymentId }))
  }
}

// ─── Registration refund sync ─────────────────────────────────────────────────
//
// Called when Razorpay fires refund.processed for an order that may belong to a
// registration. Uses the orderId to look up the payment intent (source of truth),
// then syncs Firestore and the revenue wallet.
//
// Idempotency guards:
//   - Registration paymentStatus === 'refunded'/'refund_pending' → skip entirely.
//     'refund_pending' means the organizer-initiated path is still in-flight; that
//     path will complete and handle the ledger reversal itself.
//   - Platform transaction pre-update status === 'refunded' → skip wallet debit.
//     This prevents double-debit if the organizer route already reversed the entry.

// Event-level idempotency claim keyed by the Razorpay refund id. Duplicate
// refund.processed deliveries (or concurrent re-deliveries) for the same refund
// claim once; the rest return false and skip ALL side effects (reg update,
// ledger reversal, audit, email). Claimed transactionally to be race-safe.
async function claimRefundEvent(refundId: string): Promise<boolean> {
  const ref = adminDb.collection('refundWebhookEvents').doc(refundId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (snap.exists) return false
    tx.set(ref, { refundId, source: 'registration', createdAt: FieldValue.serverTimestamp() })
    return true
  })
}

async function handleRegistrationRefund(
  orderId:          string,
  razorpayRefundId: string,
  refundAmount:     number,
): Promise<void> {
  // 0. Event-level idempotency — first delivery wins; duplicates skip entirely.
  if (!(await claimRefundEvent(razorpayRefundId))) {
    console.log('[webhook/razorpay] refund.processed — duplicate refund event, skipping:', razorpayRefundId)
    return
  }

  // 1. Load payment intent — this is keyed by orderId.
  const intent = await getPaymentIntent(orderId)
  if (!intent) {
    console.log('[webhook/razorpay] refund.processed — no payment intent, skipping:', orderId)
    return
  }

  const { registrationId } = intent
  if (!registrationId) {
    console.log('[webhook/razorpay] refund.processed — intent has no registrationId, skipping:', orderId)
    return
  }

  // 2. Load registration.
  const regRef  = adminDb.collection('registrations').doc(registrationId)
  const regSnap = await regRef.get()
  if (!regSnap.exists) {
    console.warn('[webhook/razorpay] refund.processed — registration not found:', registrationId)
    return
  }

  const regData = regSnap.data() as { paymentStatus?: string }

  // 3. Idempotency — skip if already in or approaching a terminal refund state.
  if (regData.paymentStatus === 'refunded' || regData.paymentStatus === 'refund_pending') {
    console.log('[webhook/razorpay] refund.processed — already in state, skipping:', {
      registrationId, paymentStatus: regData.paymentStatus,
    })
    return
  }

  // 4. Mark registration as refunded.
  await regRef.update({
    paymentStatus: 'refunded',
    refundId:      razorpayRefundId,
    refundAmount,
    refundedAt:    FieldValue.serverTimestamp(),
    updatedAt:     FieldValue.serverTimestamp(),
  })

  // P1-1: a refunded attendee no longer holds their session seats. Release them
  // (idempotent + transactional; the daily reconciliation is the backstop).
  void releaseRegistrationSessions(registrationId)
    .catch(err => captureFinancialError(err, { scope: 'razorpay.refund_processed.session_release_failed', registrationId }))

  // 5. Update paymentIntents record (best-effort — refund already persisted above).
  void updatePaymentIntentRefund(orderId, razorpayRefundId, 'processed', refundAmount)
    .catch(err => captureFinancialError(err, { scope: 'razorpay.refund_processed.intent_update_failed', orderId }))

  // 6. Reverse platform ledger + debit organizer revenue wallet — ATOMIC.
  // Status flip + wallet debit happen in one Firestore transaction; only the
  // call that flips the status performs the debit, so concurrent/duplicate
  // signals (incl. the organizer-initiated path) can never double-debit.
  void (async () => {
    try {
      await reversePlatformTransactionAndDebit(`ptx_${registrationId}`)
    } catch (err) {
      captureFinancialError(err, { scope: 'razorpay.refund_processed.ledger_reversal_failed', registrationId })
    }
  })()

  // 7. Registration-level audit entry (fire-and-forget).
  void writeAuditEntry(registrationId, 'refunded', 'system', 'system')
    .catch(err => captureWebhookError(err, { scope: 'razorpay.refund_processed.audit_failed', registrationId }))

  // 8. Refund confirmation email (fire-and-forget).
  // sendRefundEmail re-reads the registration doc, which is now updated with refundId/refundAmount.
  void sendRefundEmail(registrationId)
    .catch(err => captureWebhookError(err, { scope: 'razorpay.refund_processed.email_failed', registrationId }))

  console.log('[webhook/razorpay] refund.processed — registration synced:', {
    orderId, registrationId, refundId: razorpayRefundId, refundAmount,
  })
}

/**
 * GA-8 P1-1 — recover a captured LICENSE payment whose client-driven
 * /checkout/confirm never ran. Looks up the licenseOrders doc by its Razorpay order
 * id; if it's still `created`, verifies the captured amount/currency against the
 * persisted remainder and runs the SAME shared activation the confirm route uses
 * (idempotent — a replay short-circuits on `paid`). Returns true if the order was a
 * license order (handled), false if it wasn't (caller falls through to ignore).
 * Never throws.
 */
async function recoverLicensePaymentCaptured(
  orderId:         string,
  paymentId:       string,
  paymentAmount:   number | undefined,
  paymentCurrency: string | undefined,
): Promise<boolean> {
  try {
    const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION)
      .withConverter(licenseOrderConverter)
      .where('razorpayOrderId', '==', orderId)
      .limit(1)
      .get()
    if (snap.empty) return false            // not a license order — caller ignores
    const persisted = snap.docs[0].data()

    if (persisted.status === 'paid') return true   // already activated — idempotent ack
    if (persisted.status !== 'created') return true // failed/refunded — nothing to recover

    const remainderPaise = Math.max(0, persisted.razorpayAmountPaise ?? 0)
    // Defense-in-depth: the captured amount/currency must match the persisted order
    // remainder (same guard as the confirm route). On mismatch, flag + ack (never activate).
    if (paymentCurrency !== 'INR' || paymentAmount !== remainderPaise) {
      captureFinancialError('license_amount_mismatch', { scope: 'razorpay.license_mismatch', orderId, expected: remainderPaise, got: paymentAmount, currency: paymentCurrency })
      await flagSuspiciousPayment({
        source: 'license', reason: 'amount_mismatch',
        paymentId, orderId, entityId: persisted.eventId,
        expectedAmountPaise: remainderPaise, actualAmountPaise: paymentAmount,
        expectedCurrency: 'INR', actualCurrency: paymentCurrency,
      })
      return true
    }

    const def = await getEffectiveLicenseDefinition(persisted.tier)
    const activation = await activateLicenseOrder({
      eventId:           persisted.eventId,
      uid:               persisted.organizerUid,
      tier:              persisted.tier,
      licenseName:       def.name,
      basePricePaise:    def.licensePricePaise,
      persisted,
      razorpayOrderId:   orderId,
      razorpayPaymentId: paymentId,
    })
    if (activation.kind === 'coupon_exhausted') {
      await refundExhaustedCouponRemainder({ eventId: persisted.eventId, orderId, paymentId, remainderPaise, persisted })
      console.warn('[webhook/razorpay] license recovery — coupon exhausted, remainder refunded:', { orderId, eventId: persisted.eventId })
      return true
    }
    if (activation.kind === 'insufficient') {
      // The wallet portion can no longer be covered; the captured remainder alone
      // can't complete the split. Leave the order `created` for manual review.
      console.warn('[webhook/razorpay] license recovery — insufficient wallet, left for review:', { orderId, eventId: persisted.eventId })
      return true
    }
    console.log('[webhook/razorpay] license activated via recovery:', { orderId, paymentId, eventId: persisted.eventId, result: activation.kind })
    return true
  } catch (err) {
    captureFinancialError(err, { scope: 'razorpay.license_recovery', orderId, paymentId })
    return false   // unknown failure — fall through to safe ignore (Razorpay will retry the webhook)
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

  const eventType = event.event as string | undefined

  // ── 3a. H-1: payment.failed — mark stale payment intents as failed ─────────
  // Prevents 'created' intents from accumulating indefinitely when a user's
  // payment is declined, times out, or is abandoned at checkout.
  if (eventType === 'payment.failed') {
    const fPayload = event.payload as Record<string, unknown> | undefined
    const fEntity  = (fPayload?.payment as Record<string, unknown> | undefined)
      ?.entity as Record<string, unknown> | undefined
    const fOrderId   = fEntity?.order_id         as string | undefined
    const fErrorCode = fEntity?.error_code        as string | undefined
    const fErrorDesc = fEntity?.error_description as string | undefined

    if (fOrderId) {
      const intent = await getPaymentIntent(fOrderId)
      if (intent?.status === 'created') {
        const reason = fErrorDesc
          ? `payment_failed:${fErrorCode ?? 'unknown'}:${fErrorDesc}`
          : 'payment_failed'
        await markPaymentIntentFailed(fOrderId, reason)
        console.log('[webhook/razorpay] payment.failed — intent marked failed:', {
          orderId: fOrderId, fErrorCode, fErrorDesc,
        })
      }
    }
    return NextResponse.json({ received: true })
  }

  // ── 3b. refund.processed — sync dashboard/chargeback refunds to Firestore ───
  if (eventType === 'refund.processed') {
    const rPayload = event.payload as Record<string, unknown> | undefined
    const rEntity  = (rPayload?.refund as Record<string, unknown> | undefined)
      ?.entity as Record<string, unknown> | undefined
    const rOrderId  = rEntity?.order_id as string | undefined
    const rRefundId = rEntity?.id       as string | undefined
    const rAmount   = rEntity?.amount   as number | undefined

    if (rOrderId && rRefundId && typeof rAmount === 'number') {
      await handleRegistrationRefund(rOrderId, rRefundId, rAmount)
    } else {
      console.warn('[webhook/razorpay] refund.processed — missing fields in payload:', {
        rOrderId, rRefundId, rAmount,
      })
    }
    return NextResponse.json({ received: true })
  }

  // Only handle payment.captured beyond this point — other events are acknowledged but ignored.
  if (eventType !== 'payment.captured') {
    return NextResponse.json({ received: true })
  }

  // ── 4. Extract identifiers from payload ────────────────────────────────────
  const payload    = event.payload as Record<string, unknown> | undefined
  const paymentObj = (payload?.payment as Record<string, unknown> | undefined)
    ?.entity as Record<string, unknown> | undefined

  const paymentId       = paymentObj?.id       as string | undefined
  const orderId         = paymentObj?.order_id as string | undefined
  const paymentAmount   = paymentObj?.amount   as number | undefined   // paise (captured)
  const paymentCurrency = paymentObj?.currency as string | undefined

  if (!paymentId || !orderId) {
    captureWebhookError('missing_payment_identifiers', { scope: 'razorpay.missing_ids', eventType })
    return NextResponse.json({ error: 'Missing payment identifiers' }, { status: 400 })
  }

  // ── 5a. Check for wallet top-up order first ───────────────────────────────
  const topupRef  = adminDb.collection('walletTopups').doc(orderId)
  const topupSnap = await topupRef.get()
  if (topupSnap.exists) {
    const topup = topupSnap.data() as { uid: string; amountPaise: number; status: string }
    if (topup.status === 'credited') {
      return NextResponse.json({ received: true })  // fast-path idempotency
    }
    // Amount + currency verification (defense-in-depth) before crediting the wallet.
    if (paymentCurrency !== 'INR' || paymentAmount !== topup.amountPaise) {
      captureFinancialError('wallet_topup_amount_mismatch', { scope: 'razorpay.topup_mismatch', orderId, expected: topup.amountPaise, got: paymentAmount, currency: paymentCurrency })
      await flagSuspiciousPayment({
        source: 'wallet_topup', reason: 'amount_mismatch',
        paymentId, orderId, entityId: topup.uid,
        expectedAmountPaise: topup.amountPaise, actualAmountPaise: paymentAmount,
        expectedCurrency: 'INR', actualCurrency: paymentCurrency,
      })
      return NextResponse.json({ received: true })  // ack to stop retries; do not credit
    }
    // Atomic credit + status + ledger in one transaction — exactly-once via the
    // shared topup status (C-1). A transient failure records a reconciliation
    // entry so the captured payment is never lost (the cron retries idempotently).
    try {
      await atomicTopupCredit(topup.uid, topup.amountPaise, topupRef, paymentId)
      console.log('[webhook/razorpay] Wallet credited via recovery:', { orderId, paymentId, uid: topup.uid, amountPaise: topup.amountPaise })
    } catch (err) {
      await recordWalletTopupReconciliation({
        orderId, uid: topup.uid, amountPaise: topup.amountPaise, paymentId,
        error: err instanceof Error ? err.message : 'credit_failed',
      })
    }
    return NextResponse.json({ received: true })
  }

  // ── 5. Load payment intent (source of truth — never trust webhook payload) ─
  const intent = await getPaymentIntent(orderId)
  if (!intent) {
    // Not a registration intent. It may be a LICENSE order (GA-8 P1-1) whose
    // client-driven /checkout/confirm never ran (crash / tab close) — recover it here
    // using the SAME activation the confirm route uses. If it isn't a license order
    // either, ignore safely.
    const recovered = await recoverLicensePaymentCaptured(orderId, paymentId, paymentAmount, paymentCurrency)
    if (recovered) return NextResponse.json({ received: true })
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

  // ── 6.6. Amount + currency verification (defense-in-depth) ──────────────────
  // Order is implicitly verified: `intent` is keyed by orderId, which equals
  // paymentObj.order_id. Verify the CAPTURED amount + currency match the intent
  // (server-set at order creation) before confirming the registration / crediting
  // the organizer wallet. On mismatch: flag suspicious, mark the intent failed,
  // and do NOT create a registration or credit any wallet.
  if (paymentCurrency !== 'INR' || paymentAmount !== intent.amount) {
    captureFinancialError('payment_amount_mismatch', { scope: 'razorpay.payment_mismatch', orderId, expected: intent.amount, got: paymentAmount, currency: paymentCurrency })
    await markPaymentIntentFailed(orderId, `amount_mismatch:expected=${intent.amount}:got=${paymentAmount ?? 'na'}:cur=${paymentCurrency ?? 'na'}`)
    await flagSuspiciousPayment({
      source: 'registration', reason: 'amount_mismatch',
      paymentId, orderId,
      expectedAmountPaise: intent.amount, actualAmountPaise: paymentAmount,
      expectedCurrency: 'INR', actualCurrency: paymentCurrency,
    })
    return NextResponse.json({ received: true })  // ack to stop retries; do not process
  }

  // ── 6.5. F5: Gate check — cancelled/postponed/full events must not receive ─
  //         recovered registrations
  const gate = await checkRegistrationGate(intent.eventSlug, intent.passId)
  if (!gate.allowed) {
    captureWebhookError('gate_blocked_refund', { scope: 'razorpay.gate_blocked', orderId, paymentId, reason: gate.reason })
    await markPaymentIntentFailed(orderId, gate.reason)
    await triggerRefund(orderId, paymentId, intent.amount, `gate_blocked:${gate.reason}`, {
      eventSlug:     intent.eventSlug,
      attendeeEmail: intent.attendee.email,
    })
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

  // Shared refund context — populated once, reused by all triggerRefund calls below.
  const refundCtx: RefundContext = {
    eventSlug:      intent.eventSlug,
    attendeeEmail:  intent.attendee.email,
    registrationId,
  }

  // ── 8. F1: retry loop + atomic transaction: idempotency + duplicate + ───────
  //         capacity + ticket code claim + write
  for (let attempt = 0; attempt < 5; attempt++) {
    const ticketCode         = generateTicketCode()
    const ticketCodeClaimRef = adminDb.collection('ticketCodeClaims').doc(ticketCode)

    // Reset per-iteration: tracks whether the transaction created a new registration
    // (false on the idempotency no-op path — email was already sent the first time).
    let txnWasNoOp = false
    let capturedRawDetails: Record<string, unknown> = {}

    try {
      await adminDb.runTransaction(async txn => {
        // Phase 1: read intent for fast idempotency check
        const intentSnap = await txn.get(intentRef)
        const intentData = intentSnap.data() as PaymentIntentRecord

        if (intentData.status === 'paid' && intentData.registrationId) {
          txnWasNoOp = true
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
        // Capture event details for the confirmation email sent after the transaction.
        capturedRawDetails = (eventData?.eventDetails ?? {}) as Record<string, unknown>
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

        // P1-D: Live pass capacity from the transaction-locked event doc.
        // intent.passCapacity was captured at create-order time and may be stale.
        const rawPricing      = eventData?.pricing as Record<string, unknown> | null | undefined
        const livePasses      = Array.isArray(rawPricing?.passes)
          ? (rawPricing?.passes as Record<string, unknown>[])
          : []
        const livePass        = livePasses.find(p => p.id === intent.passId)
        if (!livePass) throw new CapacityExceededError('PASS_NOT_AVAILABLE')
        const livePassCapacity = livePass.unlimited === true
          ? null
          : typeof livePass.quantity === 'number' ? livePass.quantity : null

        if (eventCapacity !== null && totalCount >= eventCapacity) {
          throw new CapacityExceededError('EVENT_CAPACITY_FULL')
        }
        if (livePassCapacity !== null && passCount >= livePassCapacity) {
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

        txn.set(counterRef, buildCounterIncrement(intent.eventSlug, intent.passId, { amountPaise: intent.amount }), { merge: true })
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

      // Send confirmation email for recovered registrations only.
      // txnWasNoOp is true when the idempotency path fired (already processed by
      // verify-payment or a prior webhook delivery) — do not send a duplicate email.
      if (!txnWasNoOp) {
        await sendConfirmationEmail({
          registrationId,
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

        // P0-3: Credit organizer wallet and write the platform ledger entry.
        // verify-payment handles this on the normal (non-recovery) path. This webhook
        // recovery path previously skipped it, silently losing organizer revenue for all
        // webhook-recovered registrations (~2–5% of paid registrations).
        //
        // txnWasNoOp guards against double-credit: if verify-payment succeeded first,
        // the intent is already 'paid' and the inner transaction no-ops (txnWasNoOp = true),
        // so this block is skipped and verify-payment's ledger entry / wallet credit stand.
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
            id:                      `ptx_${registrationId}`,
            type:                    'event_registration',
            category:                'ticketed',
            organizerUid:            intent.organizerUid,
            entityId:                intent.eventSlug,
            entityType:              'event',
            sourceId:                registrationId,
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
            gatewayPaymentId:        paymentId,
            gatewayOrderId:          orderId,
          }
          const credit = {
            organizerUid:       intent.organizerUid,
            grossAmountPaise:   intent.amount,
            feesTotalPaise:     feeResult.platformFeeTotalPaise + feeResult.gatewayFeeEstimatePaise,
            netSettlementPaise: feeResult.netSettlementPaise,
          }
          // Atomic + idempotent: shares the `ptx_${registrationId}` key with
          // verify-payment, so whichever path runs first credits exactly once.
          // Registration is already created — never refund; on failure persist a
          // reconciliation record for out-of-band retry.
          try {
            await recordPlatformTransactionAndCredit(ledger, credit)
          } catch (walletErr) {
            await recordRegistrationFinancialReconciliation({
              registrationId,
              orderId,
              paymentId,
              ledger,
              credit,
              error: walletErr instanceof Error ? walletErr.message : 'financial_side_effect_failed',
            })
          }
        }
      }

      console.log('[webhook/razorpay] Registration recovered:', {
        orderId, paymentId, registrationId, eventSlug: intent.eventSlug,
      })
      return NextResponse.json({ received: true })

    } catch (err) {
      if (err instanceof TicketCodeCollisionError) {
        if (attempt < 4) continue  // generate new code, retry
        captureWebhookError('ticket_code_exhausted', { scope: 'razorpay.ticket_collision', orderId, paymentId })
        await markPaymentIntentFailed(orderId, 'ticket_code_exhausted')
        await triggerRefund(orderId, paymentId, intent.amount, 'ticket_code_exhausted', refundCtx)
        return NextResponse.json({ received: true })
      }

      if (err instanceof DuplicateRegistrationError) {
        captureWebhookError('duplicate_after_capture', { scope: 'razorpay.duplicate_refund', orderId, paymentId, reason: err.reason })
        await markPaymentIntentFailed(orderId, err.reason)
        await triggerRefund(orderId, paymentId, intent.amount, err.reason, refundCtx)
        return NextResponse.json({ received: true })
      }

      if (err instanceof CapacityExceededError) {
        captureWebhookError('capacity_exceeded_after_capture', { scope: 'razorpay.capacity_refund', orderId, paymentId, reason: err.reason })
        await markPaymentIntentFailed(orderId, err.reason)
        await triggerRefund(orderId, paymentId, intent.amount, err.reason, refundCtx)
        return NextResponse.json({ received: true })
      }

      captureWebhookError(err, { scope: 'razorpay.unexpected_refund', orderId, paymentId, eventSlug: intent.eventSlug })
      await markPaymentIntentFailed(orderId, 'webhook_transaction_error')
      await triggerRefund(orderId, paymentId, intent.amount, 'webhook_transaction_error', refundCtx)
      return NextResponse.json({ received: true })
    }
  }

  // Unreachable: every loop iteration either returns or continues.
  return NextResponse.json({ received: true })
}
