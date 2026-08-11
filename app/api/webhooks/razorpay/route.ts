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
// RD-PAY-P0-3: the registration-settlement imports (ticket code, counters, capacity, gate,
// duplicate/capacity errors, confirmation email, ledger + wallet credit) left with the
// inline settlement — they now live in settleCapturedRegistration.
import { writeAuditEntry }            from '@/lib/firebase/firestore/registrations'
import { sendRefundEmail }            from '@/lib/registrations/sendRefundEmail'
import { reversePlatformTransactionAndDebit } from '@/lib/firebase/firestore/platformTransactions'
import { flagSuspiciousPayment }      from '@/lib/payments/flagSuspicious'
// RD-PAY-P0-3 — the ONE settlement path, shared with the reconciliation sweep.
import { settleCapturedRegistration } from '@/lib/payments/settleCapturedRegistration'
import { captureFinancialError, captureWebhookError } from '@/lib/monitoring/sentry'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter } from '@/lib/licensing/schema'
import { getEffectiveDefinitionForVersion } from '@/lib/licensing/resolveCatalog'
import { CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'
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

// RD-PAY-P0-3: the local triggerRefund helper moved into settleCapturedRegistration
// alongside the settlement it served, so the refund-on-refusal policy has exactly one
// implementation shared by the webhook and the sweep. Refund SYNC (refund.processed,
// below) is a different concern and stays here.

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

    // `persisted` is a stored license ORDER (no version field, current-version artifact) →
    // resolve its tier against CURRENT_LICENSE_VERSION. Identical at version 1.
    const def = await getEffectiveDefinitionForVersion(persisted.tier, CURRENT_LICENSE_VERSION)
    if (!def) { console.error(`[webhook] license activation: unresolved tier ${String(persisted.tier)}`); return false }
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

  // ── 6.5 – 8. RD-PAY-P0-3: settle through the ONE shared recovery path ──────
  //
  // Everything that used to live inline here — the gate check + refund, the ticket-code
  // retry loop, the atomic transaction (registration · counter · intent · ticket claim ·
  // email/phone claims), the post-commit email and the ledger/wallet credit, and the
  // duplicate/capacity refund policy — moved VERBATIM to settleCapturedRegistration().
  //
  // It moved because the reconciliation sweep (the other half of P0-3) has to settle
  // orphaned captures too, and a second hand-written copy of "create a registration" is
  // exactly how recovery paths drift apart. One function, two callers, identical writes.
  //
  // Idempotency is unchanged and still lives where it always did: the payment intent is
  // read INSIDE the transaction, so concurrent settlements serialize on it and every loser
  // observes `paid` and no-ops.
  const outcome = await settleCapturedRegistration({ orderId, paymentId, intent, source: 'webhook' })

  if (outcome.kind === 'settled') {
    console.log('[webhook/razorpay] Registration recovered:', {
      orderId, paymentId, registrationId: outcome.registrationId, eventSlug: intent.eventSlug,
    })
  } else if (outcome.kind === 'refunded') {
    captureWebhookError('settlement_refused_after_capture', {
      scope: 'razorpay.settlement_refunded', orderId, paymentId, reason: outcome.reason,
    })
  }

  // Always ack: Razorpay retries a non-2xx, and every outcome above is either final or
  // deliberately left for the sweep. A retry storm helps nobody.
  return NextResponse.json({ received: true })
}
