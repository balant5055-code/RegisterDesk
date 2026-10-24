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

import { NextRequest, NextResponse }  from 'next/server'
import { scheduleServicePurchaseNotification } from '@/lib/notifications/servicePurchase'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }                    from '@/lib/firebase/admin'
import {
  getPaymentIntent,
  markPaymentIntentFailed,
  updatePaymentIntentRefund,
} from '@/lib/firebase/firestore/paymentIntents'
import { atomicTopupCredit, TopupCreditError } from '@/lib/firebase/firestore/wallet'
import { persistWalletTopupReconciliation, recordDuplicateTopupPayment, recordTopupPaymentMismatch } from '@/lib/wallet/topupReconciliation'
// RD-PAY-P0-3: the registration-settlement imports (ticket code, counters, capacity, gate,
// duplicate/capacity errors, confirmation email, ledger + wallet credit) left with the
// inline settlement — they now live in settleCapturedRegistration.
import { writeAuditEntry }            from '@/lib/firebase/firestore/registrations'
import { sendRefundEmail }            from '@/lib/registrations/sendRefundEmail'
import { reversePlatformTransactionAndDebit } from '@/lib/firebase/firestore/platformTransactions'
import {
  ensureRegistrationRefundRecord,
  claimRefundSideEffects,
  recordRefundLedgerOutcome,
  accumulatePaymentRefund,
  flagRefundForReview,
  recordRefundFailure,
  closeRefundHoldAfterFullRefund,
} from '@/lib/refunds/registrationRefunds'
import { registrationBlocksRefundSideEffects, parseRazorpayRefundEvent, type ParsedRefundEvent } from '@/lib/refunds/refundPolicy'
import { finalizePendingRegistrationRefund, resolveQueuedRefundReversal } from '@/lib/refunds/registrationRefunds'
import { extractActualGatewayFee, recordActualGatewayFee } from '@/lib/payments/actualGatewayFee'
import { flagSuspiciousPayment }      from '@/lib/payments/flagSuspicious'
// RD-PAY-P0-3 — the ONE settlement path, shared with the reconciliation sweep.
import { settleCapturedRegistration, recordDuplicateRegistrationPayment } from '@/lib/payments/settleCapturedRegistration'
import { resolvePaymentProvider } from '@/lib/payments/providers'
import { captureFinancialError, captureWebhookError } from '@/lib/monitoring/sentry'
import { LICENSE_ORDERS_COLLECTION, licenseOrderConverter, isCapacityChangePurpose } from '@/lib/licensing/schema'
import { classifyLicenceRefundEvent, recordLicenceRefundFailure } from '@/lib/admin/licenseAdminService'
import { holdSupersededPayment, isSupersededUnheld, recordManualRefundHold, recordDuplicateLicensePayment } from '@/lib/licensing/manualRefundHold'
import { applyCapacityChange, holdStaleCapacityRemainder } from '@/lib/licensing/capacityChange'
import { getEffectiveDefinitionForVersion } from '@/lib/licensing/resolveCatalog'
import { CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'
import { activateLicenseOrder, holdExhaustedCouponRemainder, holdPhotoCapacityExceeded, PHOTO_CAPACITY_HELD_MESSAGE, orderListPricePaise } from '@/lib/licensing/finalizeLicensePurchase'
import { activateAddonOrder, holdLicenceInactiveAddon, ADDON_LICENCE_INACTIVE } from '@/lib/licensing/draftCommerce'
import { settleBadgePayment } from '@/lib/licensing/printBadgePurchase/settle'
import { releaseRegistrationSessions } from '@/lib/sessions/allocation'
import { recordRefundLedgerReconciliation, recordRefundHoldClosureRetry } from '@/lib/payments/registrationReconciliation'

// ─── Signature verification ────────────────────────────────────────────────────


// RD-PAYMENT-PROVIDER-CONTRACT-04 — the implementation moved into the Razorpay adapter
// unchanged. This route stays PROVIDER-SPECIFIC by design: it verifies a Razorpay signature
// over a Razorpay raw body, and Cashfree will get its own endpoint rather than sharing this
// one. A shared webhook route is how one provider's signature check ends up reachable with
// another provider's payload.
async function verifyWebhookSignature(rawBody: string, signature: string): Promise<boolean> {
  return resolvePaymentProvider('razorpay').verifyWebhookSignature(rawBody, signature)
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

// RD-FIN-01: the `refundWebhookEvents` claim marker is gone. It guaranteed
// exactly-once side effects, but it was claimed BEFORE the refund was stored and before
// attribution was attempted — so a refund whose registration could not be resolved
// consumed its own idempotency token and vanished, unrecoverable by retry. The
// reconciliation found two real refunds (₹1.04 and ₹259.20) lost exactly that way.
//
// The claim now lives on `registrationRefunds/{refundId}` — the record that holds the
// money — via `claimRefundSideEffects`. Same exactly-once guarantee, except a refund is
// persisted first and an unattributable one stays claimable for later reconciliation
// instead of being silently consumed.

// ─── W1 · refund-to-order association ─────────────────────────────────────────
//
// Razorpay's refund entity carries the PAYMENT id, never the order id; the order is on
// payload.payment.entity (parseRazorpayRefundEvent takes it only from the refund's own payment).
// When the payment entity is absent the order is resolved from RegisterDesk's own record of that
// payment (paymentIntents.paymentId), and only when exactly one intent names it.

/** The order id for a payment, from the trusted intent record; null when none or ambiguous. */
async function orderIdForPayment(paymentId: string): Promise<string | null> {
  const snap = await adminDb.collection('paymentIntents').where('paymentId', '==', paymentId).limit(2).get()
  return snap.size === 1 ? snap.docs[0].id : null
}

/**
 * A refund of a payment that is NOT a registration (licence / capacity / add-on / badge order, wallet
 * top-up, donation) is not this ledger's: it must never become a registrationRefunds row (every row is
 * counted as registration money out). Identified from server-written records only.
 */
async function nonRegistrationPurpose(orderId: string): Promise<'license' | 'wallet_topup' | 'donation' | null> {
  const [topup, lic, donation] = await Promise.all([
    adminDb.collection('walletTopups').doc(orderId).get(),
    adminDb.collection(LICENSE_ORDERS_COLLECTION).where('razorpayOrderId', '==', orderId).limit(1).get(),
    adminDb.collection('donations').where('razorpayOrderId', '==', orderId).limit(1).get(),
  ])
  if (topup.exists) return 'wallet_topup'
  if (!lic.empty) return 'license'
  if (!donation.empty) return 'donation'
  return null
}

type RefundAttribution =
  | { kind: 'other_purpose'; orderId: string; purpose: string }
  | { kind: 'resolved'; orderId: string | null; intent: Awaited<ReturnType<typeof getPaymentIntent>>; registrationId: string | null
      /** The intent's payment is a DIFFERENT payment (a held duplicate capture): never this registration's refund. */
      otherPaymentOfOrder: boolean
      /** The intent does not record which payment it settled: the refund cannot be verified against it. */
      intentPaymentUnknown: boolean
      currencyMismatch: boolean }

async function attributeRefund(ev: ParsedRefundEvent): Promise<RefundAttribution> {
  const orderId = ev.paymentMismatch ? null : (ev.orderId ?? await orderIdForPayment(ev.paymentId))
  const intent = orderId ? await getPaymentIntent(orderId) : null
  if (orderId && !intent) {
    const purpose = await nonRegistrationPurpose(orderId)
    if (purpose) return { kind: 'other_purpose', orderId, purpose }
  }
  const intentPaymentId = intent?.paymentId ?? null
  const otherPaymentOfOrder = !!intentPaymentId && intentPaymentId !== ev.paymentId
  const intentPaymentUnknown = !!intent && !intentPaymentId
  const currencyMismatch = !!intent && !!ev.currency && ev.currency !== (intent.currency ?? 'INR')
  const verified = !!intent && intentPaymentId === ev.paymentId && !currencyMismatch
  return {
    kind: 'resolved', orderId, intent, registrationId: verified ? (intent!.registrationId ?? null) : null,
    otherPaymentOfOrder, intentPaymentUnknown, currencyMismatch,
  }
}

/**
 * M1 — close the settlement refund hold of a payment that is now FULLY refunded and reversed. The closure
 * (one transaction, audit row included) re-checks all evidence and moves no money. A closure the evidence
 * REFUSES (an open contradiction) is alerted and left for the Super Admin review. A closure that FAILED,
 * or cannot run yet (ledger reversal not landed), is queued durably for the reconciliation cron
 * (refundHoldClosureReconciliation) — the hold stays in place meanwhile. Returns false only when that
 * queue record could not be written either: the caller then answers non-2xx so Razorpay redelivers, and
 * the redelivery retries the closure (and nothing else — its side effects are already claimed).
 */
async function closeRefundHoldOrQueue(orderId: string, registrationId: string, refundId: string): Promise<boolean> {
  try {
    const closed = await closeRefundHoldAfterFullRefund({ orderId, registrationId })
    if (closed.closed || closed.why === 'no_hold') return true
    if (closed.why === 'not_reversed') return recordRefundHoldClosureRetry({ registrationId, orderId, refundId, error: 'not_reversed' })
    captureFinancialError(new Error(`refund hold not closed after full refund: ${closed.why}`), { scope: 'razorpay.refund_processed.hold_not_closed', why: closed.why, registrationId, orderId })
    return true
  } catch (err) {
    captureFinancialError(err, { scope: 'razorpay.refund_processed.hold_close_failed', registrationId, orderId })
    return recordRefundHoldClosureRetry({ registrationId, orderId, refundId, error: err instanceof Error ? err.message : 'hold closure failed' })
  }
}

async function handleRegistrationRefund(ev: ParsedRefundEvent): Promise<void> {
  const { refundId: razorpayRefundId, amountPaise: refundAmount, paymentId: gatewayPaymentId } = ev
  const at = await attributeRefund(ev)
  if (at.kind === 'other_purpose') {
    // Not a registration payment. A donation refund is synced by the donation webhook; a licence /
    // capacity / add-on / badge / top-up refund made outside RegisterDesk is surfaced, never applied here.
    // M3 — the EXPECTED echo of a licence refund RegisterDesk itself issued (activation order being
    // refunded, same payment, same amount, licence refunded / on hold) is not an anomaly: logged only.
    // Every other non-registration refund — and any licence refund that does not match — still alerts.
    const licenceEcho = at.purpose === 'license' ? await classifyLicenceRefundEvent(at.orderId, { paymentId: ev.paymentId, amountPaise: ev.amountPaise, currency: ev.currency }, { gateway: { refundId: razorpayRefundId } }) : null
    if (licenceEcho?.expected) {
      console.log('[webhook/razorpay] refund.processed — expected licence refund echo:', { orderId: at.orderId, licenseOrderId: licenceEcho.licenseOrderId, razorpayRefundId })
      return
    }
    if (at.purpose !== 'donation') {
      captureFinancialError(new Error('non-registration refund observed at gateway'), { scope: 'razorpay.refund_processed.non_registration', purpose: at.purpose, orderId: at.orderId, razorpayRefundId, ...(licenceEcho && !licenceEcho.expected ? { licenceMismatch: licenceEcho.why } : {}) })
    }
    console.log('[webhook/razorpay] refund.processed — not a registration payment, not recorded here:', { orderId: at.orderId, purpose: at.purpose, razorpayRefundId })
    return
  }
  const { orderId, intent, registrationId } = at

  // ── 0. PERSIST THE GATEWAY FACT FIRST ───────────────────────────────────────
  // Before any lookup that can fail. A refund happened at the gateway whether or not
  // RegisterDesk can name the attendee it belongs to, and storing it is not conditional
  // on attribution. Idempotent on the Razorpay refund id.
  // RD-FIN-02 · B6 — a refund of a DIFFERENT payment on this order (a duplicate capture held for
  // review) is not this registration's refund: never mark the settled registration refunded, never
  // reverse its ledger or debit the wallet for it. Recorded as a processed, unlinked refund.
  let record: Awaited<ReturnType<typeof ensureRegistrationRefundRecord>>['record']
  try {
    ;({ record } = await ensureRegistrationRefundRecord({
      razorpayRefundId,
      gatewayPaymentId,
      gatewayOrderId:  orderId,
      amountPaise:     refundAmount,
      origin:          'webhook',
      initiatedBy:     'webhook',
      reason:          'gateway_refund_processed',
      registrationId,
      eventSlug:       intent?.eventSlug ?? null,
      // W1 — the owner from the payment's OWN intent (the attribution recoverUnattributed already trusts),
      // so organizer refund totals never depend on the capped unattributed-refund recovery.
      organizerUid:    intent?.organizerUid ?? null,
      ...(at.otherPaymentOfOrder ? { status: 'processed' as const, metadata: { duplicatePaymentRefund: true } } : {}),
    }))
  } catch (err) {
    // A refund we cannot even record must NOT be acknowledged as handled — let Razorpay
    // retry. This is the one place in this handler where failing loudly is correct.
    captureFinancialError(err, { scope: 'razorpay.refund_record_failed', razorpayRefundId, orderId })
    throw err
  }

  // W1 — the reasons a recorded refund gets NO side effects, each flagged for a human, never guessed.
  const review = async (reason: Parameters<typeof flagRefundForReview>[1], detail: Record<string, unknown>) => {
    await flagRefundForReview(razorpayRefundId, reason, detail)
    captureFinancialError(new Error(`registration refund needs review: ${reason}`), { scope: 'razorpay.refund_processed.review', reason, razorpayRefundId, orderId, ...detail })
  }
  if (record.status === 'failed') return review('processed_after_failed', { gatewayPaymentId })
  if (ev.paymentMismatch) return review('payment_mismatch', { gatewayPaymentId, note: 'payment entity names another payment' })
  if (at.currencyMismatch) return review('currency_mismatch', { refundCurrency: ev.currency, intentCurrency: intent?.currency ?? null })
  if (at.intentPaymentUnknown) return review('payment_mismatch', { gatewayPaymentId, note: 'intent records no payment id' })

  // 1. No intent → the refund is recorded and `unlinked`. Reconciliation can attribute it
  //    later; nothing is lost.
  if (!intent || !registrationId || !orderId) {
    console.log('[webhook/razorpay] refund.processed — recorded UNLINKED (no intent/registration):',
      { orderId, razorpayRefundId })
    return
  }

  // 1b. W1 — cumulative accounting against the CHARGED amount, exactly once per refund id. Only the
  //     refund that brings the total to the full charge may apply the full-refund side effects; a
  //     partial refund is recorded (it IS counted as money out in every refund total) and flagged —
  //     the registration stays as it is and nothing is reversed, because no partial ledger model exists.
  // F1 / F2 — a partial / exceeding / after-full refund gets its review reason AND the payment's settlement
  //     hold in the SAME transaction as the counting (so neither can be lost to a failed second write and a
  //     redelivery that then sees a duplicate). Only the alert below is outside it.
  const acc = await accumulatePaymentRefund(orderId, razorpayRefundId, refundAmount)
  if (acc.kind === 'refund_failed') return review('processed_after_failed', { gatewayPaymentId })
  if (acc.kind === 'no_intent') return
  // RD-REFUND-MANUAL-01 — 'manual_conflict': a manual refund of this payment exists; the gateway refund is held for review.
  if (acc.kind === 'partial' || acc.kind === 'exceeds' || acc.kind === 'already_full' || acc.kind === 'manual_conflict') {
    captureFinancialError(new Error(`registration refund needs review: ${acc.kind}`), {
      scope: 'razorpay.refund_processed.review', kind: acc.kind, razorpayRefundId, orderId,
      priorPaise: acc.priorPaise, refundPaise: refundAmount, chargedPaise: intent.amount,
      settlementHeld: acc.settlementHeld === true, settlementAlreadyReleased: acc.settlementAlreadyReleased === true,
    })
    return
  }
  // `duplicate`: a redelivery. Only the refund that completed the full amount continues (a crash-retry of
  // its side effects, still guarded exactly-once below); a redelivered partial changes nothing.
  if (acc.kind === 'duplicate' && acc.fullBy !== razorpayRefundId) return
  const cumulativeRefund = intent.amount

  // 2. Load registration.
  const regRef  = adminDb.collection('registrations').doc(registrationId)
  const regSnap = await regRef.get()
  if (!regSnap.exists) {
    console.warn('[webhook/razorpay] refund.processed — recorded, registration not found:', registrationId)
    return
  }

  const regData = regSnap.data() as { paymentStatus?: string; organizerUid?: unknown }

  // 3. Registration-side guard — the organizer path may be mid-flight or already done.
  // RD-FIN-02 · a Super Admin refund that reached the gateway but whose route died (or is slower than
  // this delivery) sits in refund_pending. Finish it HERE, with evidence, exactly once: the transition
  // is the gate both paths contend on. Anything else in refund_pending / refunded is skipped as before.
  // F3 — the record's claim commits in the SAME transaction as the registration transition, and that
  // transaction refuses a refund recorded FAILED: a concurrent refund.failed lands either before (no
  // transition, flagged here) or after (it finds the refund processed and is flagged, never overwriting).
  if (regData.paymentStatus === 'refund_pending') {
    const fin = await finalizePendingRegistrationRefund(registrationId, { refundId: razorpayRefundId, amountPaise: refundAmount, gatewayPaymentId }, { claimRecord: true })
    if (fin === 'refund_failed') return review('processed_after_failed', { gatewayPaymentId, stage: 'finalize' })
    if (fin !== 'won') {
      console.log('[webhook/razorpay] refund.processed — pending refund not finalized:', { registrationId, fin })
      return
    }
  } else if (registrationBlocksRefundSideEffects(regData.paymentStatus)) {
    console.log('[webhook/razorpay] refund.processed — already in state, skipping:', {
      registrationId, paymentStatus: regData.paymentStatus,
    })
    // M1 — a redelivery (or the echo of an in-app full refund): only the hold closure is retried here —
    // idempotent, evidence-gated, no money; every other side effect stays claimed and is not repeated.
    if (regData.paymentStatus === 'refunded' && !(await closeRefundHoldOrQueue(orderId, registrationId, razorpayRefundId))) {
      throw new Error('refund hold closure failed and could not be queued — redelivery required')
    }
    return
  } else {
    // 3b. Exactly-once claim, now held by the refund RECORD. RD-REFUND-RECOVER-01 — the registration is
    //     marked refunded, the unreleased settlement held and the ledger reversal QUEUED in the SAME
    //     transaction as the claim: a crash after it can no longer leave the registration `paid` with
    //     the ledger unreversed behind a claim every redelivery finds taken.
    const claim = await claimRefundSideEffects(razorpayRefundId, { markRegistration: { registrationId, refundAmountPaise: cumulativeRefund } })
    if (!claim.claimed) {
      // F3 — refused because the gateway reported this refund FAILED meanwhile: a durable review, not a log.
      if (claim.record?.status === 'failed') return review('processed_after_failed', { gatewayPaymentId, stage: 'claim' })
      console.log('[webhook/razorpay] refund.processed — side effects already applied:', razorpayRefundId)
      return
    }
  }

  // 4. Mark registration as refunded (the cumulative refunded amount — the full charge).
  await regRef.update({
    paymentStatus: 'refunded',
    refundId:      razorpayRefundId,
    refundAmount:  cumulativeRefund,
    refundedAt:    FieldValue.serverTimestamp(),
    updatedAt:     FieldValue.serverTimestamp(),
  })

  // P1-1: a refunded attendee no longer holds their session seats. Release them
  // (idempotent + transactional; the daily reconciliation is the backstop).
  void releaseRegistrationSessions(registrationId)
    .catch(err => captureFinancialError(err, { scope: 'razorpay.refund_processed.session_release_failed', registrationId }))

  // 5. Update paymentIntents record (awaited; best-effort — refund already persisted above).
  await updatePaymentIntentRefund(orderId, razorpayRefundId, 'processed', cumulativeRefund)
    .catch(err => captureFinancialError(err, { scope: 'razorpay.refund_processed.intent_update_failed', orderId }))

  let holdClosureQueued = true
  // 6. Reverse platform ledger + debit organizer revenue wallet — ATOMIC.
  // Status flip + wallet debit happen in one Firestore transaction; only the
  // call that flips the status performs the debit, so concurrent/duplicate
  // signals (incl. the organizer-initiated path) can never double-debit.
  //
  // RD-PHASE4-S4 · F9 — AWAITED. It used to run in a detached promise that the platform could
  // drop after the response. The side-effect claim above is already held, so a redelivery will
  // NOT redo this step: a failure is therefore recorded in the durable, idempotent refund-ledger
  // reconciliation queue (the same backstop the registration refund route uses), never thrown.
  try {
    const result = await reversePlatformTransactionAndDebit(`ptx_${registrationId}`)
    // RD-REFUND-RECOVER-01 — the reversal queued with the refund is done; resolve it (best-effort —
    // a record left pending is replayed by the drain as an idempotent no-op).
    await resolveQueuedRefundReversal(registrationId)
    // Recorded onto the refund so "was the ledger actually reversed, and by how much?"
    // is answerable from the refund itself rather than by joining two collections.
    await recordRefundLedgerOutcome(razorpayRefundId, {
      reversed: result.reversed, debitedPaise: result.debited,
    }).catch(() => {})
    // M1 — the payment is now FULLY refunded and its settlement reversed: a refund hold an earlier partial
    // refund placed has nothing left to protect. Closed only on full, consistent evidence (else it stays
    // open and visible); a failed closure is queued for retry (see closeRefundHoldOrQueue).
    holdClosureQueued = await closeRefundHoldOrQueue(orderId, registrationId, razorpayRefundId)
  } catch (err) {
    captureFinancialError(err, { scope: 'razorpay.refund_processed.ledger_reversal_failed', registrationId })
    await recordRefundLedgerReconciliation({
      registrationId,
      ptxId:        `ptx_${registrationId}`,
      organizerUid: typeof regData.organizerUid === 'string' ? regData.organizerUid : '',
      error:        err instanceof Error ? err.message : 'ledger reversal failed',
    })
    // M1 — the closure depends on that reversal: queue it too when the payment carries a refund hold
    // (drained after the reversal retry; it waits while the ledger is not reversed).
    const held = await adminDb.doc(`platformTransactions/ptx_${registrationId}`).get().then(s => s.get('releaseHold') != null, () => true)
    if (held) holdClosureQueued = await recordRefundHoldClosureRetry({ registrationId, orderId, refundId: razorpayRefundId, error: 'ledger reversal deferred' })
  }

  // 7. Registration-level audit entry (awaited; a failure is reported, never thrown).
  await writeAuditEntry(registrationId, 'refunded', 'system', 'system')
    .catch(err => captureWebhookError(err, { scope: 'razorpay.refund_processed.audit_failed', registrationId }))

  // 8. Refund confirmation email (fire-and-forget).
  // sendRefundEmail re-reads the registration doc, which is now updated with refundId/refundAmount.
  void sendRefundEmail(registrationId)
    .catch(err => captureWebhookError(err, { scope: 'razorpay.refund_processed.email_failed', registrationId }))

  console.log('[webhook/razorpay] refund.processed — registration synced:', {
    orderId, registrationId, refundId: razorpayRefundId, refundAmount: cumulativeRefund,
  })
  // M1 — thrown LAST (after the audit entry and email above): a closure that failed and could not be
  // queued must not be acknowledged; the redelivery retries only the closure.
  if (!holdClosureQueued) throw new Error('refund hold closure failed and could not be queued — redelivery required')
}

/**
 * W1 · refund.failed — the gateway reports that a refund did NOT go through. Recorded durably on the
 * refund record (never counted as money out), idempotently. NOTHING is reversed, re-credited, retried,
 * reactivated or cancelled, and no refund is initiated: a failure that contradicts state RegisterDesk
 * already applied (a processed refund, a registration already marked refunded / ledger reversed, or a
 * refund_pending registration) is flagged for a human instead.
 */
async function handleRegistrationRefundFailed(ev: ParsedRefundEvent): Promise<void> {
  const { refundId: razorpayRefundId, amountPaise, paymentId: gatewayPaymentId } = ev
  const at = await attributeRefund(ev)
  if (at.kind === 'other_purpose') {
    // M2 — a licence refund RegisterDesk issued, accepted by the gateway, now reported FAILED: recorded as a
    // durable manual-review state on the licence (nothing retried, reactivated or restored). A failure the
    // in-app refund does not explain still alerts as before. Both are genuine financial events: alerted.
    if (at.purpose === 'license') {
      const r = await recordLicenceRefundFailure({ razorpayOrderId: at.orderId, refundId: razorpayRefundId, paymentId: gatewayPaymentId, amountPaise, currency: ev.currency, failureReason: ev.failureReason })
      if (r.outcome === 'duplicate') return
      captureFinancialError(new Error('licence refund FAILED at gateway'), { scope: 'razorpay.refund_failed.licence', orderId: at.orderId, razorpayRefundId, outcome: r.outcome, ...(r.outcome === 'not_applicable' ? { why: r.why } : { evidence: r.evidence, licence: r.licenceSlug }) })
      return
    }
    if (at.purpose !== 'donation') {
      captureFinancialError(new Error('non-registration refund FAILED at gateway'), { scope: 'razorpay.refund_failed.non_registration', purpose: at.purpose, orderId: at.orderId, razorpayRefundId })
    }
    return
  }
  const { orderId, intent, registrationId } = at
  let res: Awaited<ReturnType<typeof recordRefundFailure>>
  try {
    res = await recordRefundFailure({
      razorpayRefundId, gatewayPaymentId, gatewayOrderId: orderId, amountPaise,
      origin: 'webhook', initiatedBy: 'webhook', reason: 'gateway_refund_failed',
      registrationId, eventSlug: intent?.eventSlug ?? null, organizerUid: intent?.organizerUid ?? null, failureReason: ev.failureReason,
    })
  } catch (err) {
    captureFinancialError(err, { scope: 'razorpay.refund_failed_record_failed', razorpayRefundId, orderId })
    throw err                                     // non-2xx: Razorpay redelivers
  }
  if (res.outcome === 'duplicate') return
  // F2 / F3 — every consequence (un-counting, side-effect / pending conflicts) was decided from that
  // transaction's own reads and written with it; this only raises the alert.
  if (res.outcome === 'conflict_processed' || res.reasons.length) {
    captureFinancialError(new Error('registration refund failed — needs review'), {
      scope: 'razorpay.refund_failed.review', razorpayRefundId, orderId, outcome: res.outcome,
      reasons: res.outcome === 'conflict_processed' ? ['failed_after_processed'] : res.reasons,
    })
  }
}

/**
 * GA-8 P1-1 — recover a captured LICENSE payment whose client-driven
 * /checkout/confirm never ran. Looks up the licenseOrders doc by its Razorpay order
 * id; if it's still `created`, verifies the captured amount/currency against the
 * persisted Razorpay amount (the WHOLE price) and runs the SAME shared activation the confirm route uses
 * (idempotent — a replay short-circuits on `paid`). Returns 'handled' for a license order
 * that was settled, held or safely ignored; 'not_license' when it isn't one (caller ignores);
 * 'retry' when processing genuinely FAILED (RD-F3 — the caller answers non-2xx). Never throws.
 */
/** RD-F3 — 'retry' ⇒ a genuine processing failure: answer non-2xx so Razorpay redelivers. */
type LicenseRecovery = 'handled' | 'not_license' | 'retry'

/**
 * RD-F3 / RD-L6 — a capacity order ALREADY made terminal by the apply transaction (F1: stale capacity;
 * L6 D3: event no longer live) whose hold is missing (the hold write failed on an earlier delivery):
 * complete THE deterministic hold, re-checked in its transaction (still terminal for the same reason,
 * same Razorpay order + amount, no other hold). Returns false when the order is not such an order.
 * A failed write throws (⇒ 'retry').
 */
async function completeRefusedCapacityHold(
  order: { orderId: string; eventId: string; organizerUid: string; purpose?: unknown; status?: unknown; razorpayAmountPaise?: number | null },
  razorpayOrderId: string, paymentId: string, paymentAmount: number | undefined, paymentCurrency: string | undefined,
): Promise<boolean> {
  const failReason = (order as { failReason?: unknown }).failReason
  if (!isCapacityChangePurpose(order.purpose) || order.status !== 'failed'
      || (failReason !== 'capacity_stale' && failReason !== 'lifecycle_ineligible')
      || (order as { manualRefundHoldId?: unknown }).manualRefundHoldId != null) return false
  const amount = Math.max(0, order.razorpayAmountPaise ?? 0)
  if (paymentCurrency === 'INR' && paymentAmount === amount && amount > 0) {
    await recordManualRefundHold({
      orderDocId: order.orderId, razorpayOrderId, paymentId, amountPaise: amount,
      eventId: order.eventId, organizerUid: order.organizerUid,
      reason: failReason, source: 'license_capacity', failReason,
      onlyIfOrder: (o, holdId) => o?.status === 'failed' && o?.failReason === failReason
        && (o?.manualRefundHoldId == null || o?.manualRefundHoldId === holdId)
        && o?.razorpayOrderId === razorpayOrderId && o?.razorpayAmountPaise === amount,
    })
    console.warn('[webhook/razorpay] capacity recovery — refused order hold completed on retry:', { orderId: razorpayOrderId, eventId: order.eventId, reason: failReason })
  }
  return true
}

async function recoverLicensePaymentCaptured(
  orderId:         string,
  paymentId:       string,
  paymentAmount:   number | undefined,
  paymentCurrency: string | undefined,
): Promise<LicenseRecovery> {
  try {
    const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION)
      .withConverter(licenseOrderConverter)
      .where('razorpayOrderId', '==', orderId)
      .limit(1)
      .get()
    if (snap.empty) return 'not_license'    // not a license order — caller ignores
    const persisted = snap.docs[0].data()

    // RD-PRINT-BILL-P4 · an ID-badge purchase order is settled ONLY by its own shared settlement
    // (activate once, or a durable hold — duplicates, superseded and expired orders included). Any
    // throw lands in the catch below ⇒ 'retry' ⇒ non-2xx, so Razorpay redelivers.
    if (persisted.purpose === 'print_badges') {
      const settled = await settleBadgePayment({
        orderId: persisted.orderId, razorpayOrderId: orderId, paymentId,
        amountPaise: paymentAmount, currency: paymentCurrency, via: 'webhook',
      })
      console.log('[webhook/razorpay] badge purchase settled via recovery:', { orderId, paymentId, result: settled.kind })
      return 'handled'
    }

    if (persisted.status === 'paid') {
      // RD-CE-FIX M4 — the SAME payment again is a replay: idempotent ack. A DIFFERENT captured payment
      // on an order that is already paid is real money that nothing would otherwise record: it is held
      // for Super Admin review (no second entitlement, nothing revoked, no automatic refund).
      const credited = (persisted as { razorpayPaymentId?: string | null }).razorpayPaymentId ?? null
      // A PAID order keeps the final charged amount in amountPaise (licensing is Razorpay-only, full amount).
      const expected = Math.max(0, persisted.razorpayAmountPaise ?? (persisted as { amountPaise?: number }).amountPaise ?? 0)
      if (paymentId && paymentId !== credited && paymentCurrency === 'INR' && expected > 0 && paymentAmount === expected) {
        const dup = await recordDuplicateLicensePayment({
          orderDocId: persisted.orderId, razorpayOrderId: orderId, paymentId, creditedPaymentId: credited,
          amountPaise: expected, eventId: persisted.eventId, organizerUid: persisted.organizerUid, detectedBy: 'webhook',
        })
        console.warn('[webhook/razorpay] SECOND payment on an already-paid licence order — HELD for review:', { orderId, paymentId, credited, created: dup.created })
      }
      return 'handled'   // already activated — never activated twice
    }

    // RD-F2 — a payment CAPTURED on an order that was already SUPERSEDED (e.g. a late UPI approval).
    // Never applied (F1); the money is recorded as the same idempotent manual-refund hold the confirm
    // routes use, so it is not lost if the organizer never comes back to confirm. Add-on and
    // capacity-change orders keep their Razorpay order id when superseded, so they are found here.
    if (isSupersededUnheld(persisted as never, `license_hold_${persisted.orderId}`)) {
      const heldAmount = Math.max(0, persisted.razorpayAmountPaise ?? 0)
      if (paymentCurrency !== 'INR' || paymentAmount !== heldAmount || heldAmount <= 0) {
        captureFinancialError('superseded_amount_mismatch', { scope: 'razorpay.superseded_mismatch', orderId, expected: heldAmount, got: paymentAmount, currency: paymentCurrency })
        await flagSuspiciousPayment({
          source: 'license', reason: 'amount_mismatch', paymentId, orderId, entityId: persisted.eventId,
          expectedAmountPaise: heldAmount, actualAmountPaise: paymentAmount, expectedCurrency: 'INR', actualCurrency: paymentCurrency,
        })
        return 'handled'
      }
      const held = await holdSupersededPayment({
        orderDocId: persisted.orderId, razorpayOrderId: orderId, paymentId, amountPaise: heldAmount,
        eventId: persisted.eventId, organizerUid: persisted.organizerUid,
        source: isCapacityChangePurpose(persisted.purpose) ? 'license_capacity' : 'license',
      })
      console.warn('[webhook/razorpay] payment captured on a SUPERSEDED licence order — HELD for review:', { orderId, paymentId, eventId: persisted.eventId, created: held.created, skipped: held.skipped === true })
      return 'handled'
    }
    // RD-F3 — a capacity order ALREADY made terminal as stale (F1 marks it inside the apply transaction)
    // whose hold write failed on an earlier delivery: this retry completes the hold. Same deterministic
    // hold, re-checked in its transaction (still stale, same Razorpay order + amount, no other hold).
    // RD-L6 D3 — the same for an order made terminal because its event is no longer live.
    if (await completeRefusedCapacityHold(persisted, orderId, paymentId, paymentAmount, paymentCurrency)) return 'handled'
    // RD-SA-COMMERCE-P1 — an add-on refused for an inactive licence: complete THE same deterministic hold if
    // an earlier delivery's write failed (re-checked in its transaction); a different payment on an order
    // already held is recorded as a duplicate. Never granted.
    if (persisted.purpose === 'addon' && persisted.status === 'failed'
        && (persisted as { failReason?: unknown }).failReason === ADDON_LICENCE_INACTIVE) {
      const amount = Math.max(0, persisted.razorpayAmountPaise ?? 0)
      if (paymentCurrency === 'INR' && paymentAmount === amount && amount > 0) {
        await holdLicenceInactiveAddon({ orderId: persisted.orderId, razorpayOrderId: orderId, paymentId, amountPaise: amount, eventId: persisted.eventId, organizerUid: persisted.organizerUid, detectedBy: 'webhook' })
        console.warn('[webhook/razorpay] add-on licence-inactive hold completed on retry:', { orderId, eventId: persisted.eventId })
      }
      return 'handled'
    }
    if (persisted.status !== 'created') return 'handled' // failed/refunded — nothing to recover

    const razorpayAmountPaise = Math.max(0, persisted.razorpayAmountPaise ?? 0)

    // ══ RD-CAPACITY-01 · a CAPACITY CHANGE is settled by its own transaction ═══════
    //
    // This lookup is by Razorpay order id across the whole collection, so it also finds
    // capacity-change orders. They must NOT go through activateLicenseOrder: that function
    // settles the event's single activation order at `lic_<eventId>`, so a capacity payment
    // routed into it would be written onto the WRONG document — and, because that document
    // is already `paid`, silently swallowed as an idempotent replay. The organizer would be
    // charged and get no capacity. Dispatching on the stored purpose is what prevents it.
    if (isCapacityChangePurpose(persisted.purpose)) {
      if (paymentCurrency !== 'INR' || paymentAmount !== razorpayAmountPaise) {
        captureFinancialError('capacity_amount_mismatch', { scope: 'razorpay.capacity_mismatch', orderId, expected: razorpayAmountPaise, got: paymentAmount, currency: paymentCurrency })
        await flagSuspiciousPayment({
          source: 'license', reason: 'amount_mismatch',
          paymentId, orderId, entityId: persisted.eventId,
          expectedAmountPaise: razorpayAmountPaise, actualAmountPaise: paymentAmount,
          expectedCurrency: 'INR', actualCurrency: paymentCurrency,
        })
        return 'handled'
      }
      const applied = await applyCapacityChange({
        eventId:           persisted.eventId,
        organizerUid:      persisted.organizerUid,
        orderId:           persisted.orderId,
        razorpayOrderId:   orderId,
        razorpayPaymentId: paymentId,
      })
      if (applied.kind === 'stale' || applied.kind === 'lifecycle_ineligible') {
        await holdStaleCapacityRemainder({
          orderId: persisted.orderId, eventId: persisted.eventId, paymentId, remainderPaise: razorpayAmountPaise,
          priorRefundId: (persisted as { staleRefundId?: string }).staleRefundId ?? null,
          reason: applied.kind === 'stale' ? 'capacity_stale' : 'lifecycle_ineligible',
        }, { rethrow: true })   // RD-F3 — a failed hold write ⇒ retry, never a silent 200
        console.warn(`[webhook/razorpay] capacity recovery — ${applied.kind === 'stale' ? 'capacity moved' : 'event no longer live'}, payment HELD for a manual refund decision:`, { orderId, eventId: persisted.eventId })
        return 'handled'
      }
      if (applied.kind === 'ineligible') {
        // RD-L6 D2 — the order was `created` when it was looked up above but not by the time the apply
        // transaction ran (superseded, held or made terminal in between). Decide on its LATEST state:
        // a superseded, unheld order gets the F2 hold; a stale / not-live one without its hold gets
        // that hold. Either write failing ⇒ throws ⇒ 'retry' (non-2xx), never a silent 200.
        const latestSnap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).withConverter(licenseOrderConverter).doc(persisted.orderId).get()
        const latest = latestSnap.exists ? latestSnap.data() : undefined
        if (latest && isSupersededUnheld(latest as never, `license_hold_${persisted.orderId}`)) {
          const held = await holdSupersededPayment({
            orderDocId: persisted.orderId, razorpayOrderId: orderId, paymentId, amountPaise: razorpayAmountPaise,
            eventId: persisted.eventId, organizerUid: persisted.organizerUid, source: 'license_capacity',
          })
          console.warn('[webhook/razorpay] capacity order superseded during settlement — payment HELD for review:', { orderId, paymentId, eventId: persisted.eventId, created: held.created, skipped: held.skipped === true })
          return 'handled'
        }
        if (latest) await completeRefusedCapacityHold(latest, orderId, paymentId, paymentAmount, paymentCurrency)
        return 'handled'
      }
      if (applied.kind === 'not_found') {
        // RD-L6 — the order exists but its event (or its snapshot) does not. There is no event to attach
        // a hold to under the existing hold rules, so nothing is fabricated: surfaced for manual review.
        captureFinancialError('capacity_event_missing', { scope: 'razorpay.capacity_event_missing', orderId, paymentId, eventId: persisted.eventId, amount: razorpayAmountPaise })
        console.error('[webhook/razorpay] capacity recovery — order/event not found, payment left for MANUAL review:', { orderId, paymentId, eventId: persisted.eventId })
        return 'handled'
      }
      if (applied.kind === 'underpaid') {
        // RD-LICENSE-PAYMENT-01 · a pre-change order whose Razorpay amount was only part of its
        // total. Never applied at a discount and never topped up from a wallet — flagged for review.
        captureFinancialError('capacity_underpaid_order', { scope: 'razorpay.capacity_underpaid', orderId, paymentId, amount: razorpayAmountPaise })
        console.warn('[webhook/razorpay] capacity recovery — order does not cover its full total, left for review:', { orderId, eventId: persisted.eventId })
        return 'handled'
      }
      // Wallet-02 — purchase notifications, once per order (claim-deduplicated; never throws).
      scheduleServicePurchaseNotification(persisted.orderId)
      console.log('[webhook/razorpay] capacity change applied via recovery:', { orderId, paymentId, eventId: persisted.eventId, capacity: applied.newCapacity, result: applied.kind })
      return 'handled'
    }

    // RD-EVENT-COMMERCE-02 · a pre-publish ADD-ON order is settled by its own shared
    // transaction — never by activateLicenseOrder, which only settles `lic_<draftId>`.
    if (persisted.purpose === 'addon') {
      if (paymentCurrency !== 'INR' || paymentAmount !== razorpayAmountPaise) {
        captureFinancialError('addon_amount_mismatch', { scope: 'razorpay.addon_mismatch', orderId, expected: razorpayAmountPaise, got: paymentAmount, currency: paymentCurrency })
        await flagSuspiciousPayment({
          source: 'license', reason: 'amount_mismatch', paymentId, orderId, entityId: persisted.eventId,
          expectedAmountPaise: razorpayAmountPaise, actualAmountPaise: paymentAmount, expectedCurrency: 'INR', actualCurrency: paymentCurrency,
        })
        return 'handled'
      }
      const r = await activateAddonOrder({ orderId: persisted.orderId, razorpayOrderId: orderId, razorpayPaymentId: paymentId })
      // RD-PHOTO-01 — would exceed the event's 3,000-photo maximum: nothing granted, order superseded
      // in that transaction; hold the captured payment for a manual refund decision.
      if (r === 'over_capacity') {
        const held = await holdSupersededPayment({
          orderDocId: persisted.orderId, razorpayOrderId: orderId, paymentId, amountPaise: razorpayAmountPaise,
          eventId: persisted.eventId, organizerUid: persisted.organizerUid, source: 'license',
        })
        console.warn('[webhook/razorpay] add-on would exceed the 3,000-photo maximum — payment HELD for review:', { orderId, paymentId, eventId: persisted.eventId, created: held.created })
        return 'handled'
      }
      // RD-SA-COMMERCE-P1 — the event's licence is inactive: nothing granted, order failed; hold the payment.
      if (r === 'licence_inactive') {
        const held = await holdLicenceInactiveAddon({
          orderId: persisted.orderId, razorpayOrderId: orderId, paymentId, amountPaise: razorpayAmountPaise,
          eventId: persisted.eventId, organizerUid: persisted.organizerUid, detectedBy: 'webhook',
        })
        console.warn('[webhook/razorpay] add-on refused (licence inactive) — payment HELD for review:', { orderId, paymentId, eventId: persisted.eventId, created: held.created })
        return 'handled'
      }
      if (r === 'inconsistent') {
        captureFinancialError('addon_inconsistent', { scope: 'razorpay.addon_inconsistent', orderId, paymentId })
        await flagSuspiciousPayment({
          source: 'license', reason: 'addon_inconsistent', paymentId, orderId, entityId: persisted.eventId,
          expectedAmountPaise: razorpayAmountPaise, actualAmountPaise: paymentAmount, expectedCurrency: 'INR', actualCurrency: paymentCurrency,
        })
      }
      if (r === 'ok' || r === 'already') scheduleServicePurchaseNotification(persisted.orderId)   // Wallet-02 — purchase notifications, once per order (claim-deduplicated; never throws).
      console.log('[webhook/razorpay] add-on settled via recovery:', { orderId, paymentId, eventId: persisted.eventId, result: r })
      return 'handled'
    }

    // Defense-in-depth: the captured amount/currency must match the persisted order
    // Razorpay amount (same guard as the confirm route). On mismatch, flag + ack (never activate).
    if (paymentCurrency !== 'INR' || paymentAmount !== razorpayAmountPaise) {
      captureFinancialError('license_amount_mismatch', { scope: 'razorpay.license_mismatch', orderId, expected: razorpayAmountPaise, got: paymentAmount, currency: paymentCurrency })
      await flagSuspiciousPayment({
        source: 'license', reason: 'amount_mismatch',
        paymentId, orderId, entityId: persisted.eventId,
        expectedAmountPaise: razorpayAmountPaise, actualAmountPaise: paymentAmount,
        expectedCurrency: 'INR', actualCurrency: paymentCurrency,
      })
      return 'handled'
    }

    // `persisted` is a stored license ORDER (no version field, current-version artifact) →
    // resolve its tier against CURRENT_LICENSE_VERSION. Identical at version 1.
    const def = await getEffectiveDefinitionForVersion(persisted.tier, CURRENT_LICENSE_VERSION)
    if (!def) {
      // A permanent configuration problem, not a transient one: alert and acknowledge (a retry cannot fix it).
      captureFinancialError('license_unresolved_tier', { scope: 'razorpay.license_unresolved_tier', orderId, paymentId })
      console.error(`[webhook] license activation: unresolved tier ${String(persisted.tier)}`)
      return 'handled'
    }

    // RD-CAPACITY-01 · a capacity-priced order is priced by its OWN immutable snapshot, not
    // by a tier. Without this the backstop would settle a captured capacity payment against
    // the free tier's zero price and record a zero activation for real money. The snapshot
    // travels on the order precisely so this recovery path needs no quote, no configuration
    // read, and no second pricing implementation.
    const capacityCharge = persisted.commercialModel === 'capacity' ? persisted.capacityChange ?? null : null
    const activation = await activateLicenseOrder({
      eventId:           persisted.eventId,
      uid:               persisted.organizerUid,
      tier:              persisted.tier,
      licenseName:       capacityCharge ? 'Event activation' : def.name,
      basePricePaise:    orderListPricePaise(persisted, def.licensePricePaise),
      persisted,
      razorpayOrderId:   orderId,
      razorpayPaymentId: paymentId,
      ...(capacityCharge ? { capacitySnapshot: capacityCharge } : {}),
    })
    if (activation.kind === 'superseded') {
      // RD-M4 D1 — the activation order was replaced between the lookup above and the activation
      // transaction. Nothing was written. Retry (F3): the redelivery's lookup by Razorpay order id finds
      // only the F2A archive now, and the superseded-payment hold runs there.
      console.warn('[webhook/razorpay] license recovery raced an order replacement — retrying:', { orderId, eventId: persisted.eventId })
      return 'retry'
    }
    if (activation.kind === 'photo_capacity_exceeded') {
      await holdPhotoCapacityExceeded({ eventId: persisted.eventId, orderId, paymentId, amountPaise: razorpayAmountPaise }, { rethrow: true })
      console.warn('[webhook/razorpay] license recovery — would exceed the 3,000-photo maximum, payment HELD for review:', { orderId, eventId: persisted.eventId })
      return 'handled'
    }
    if (activation.kind === 'coupon_exhausted') {
      await holdExhaustedCouponRemainder({ eventId: persisted.eventId, orderId, paymentId, remainderPaise: razorpayAmountPaise, persisted }, { rethrow: true })   // RD-F3
      console.warn('[webhook/razorpay] license recovery — coupon exhausted, payment HELD for a manual refund decision:', { orderId, eventId: persisted.eventId })
      return 'handled'
    }
    if (activation.kind === 'underpaid') {
      // RD-LICENSE-PAYMENT-01 · a pre-change order whose Razorpay amount was only part of the
      // price (the rest was planned from the communication wallet). It is never activated at
      // a discount and never topped up from a wallet — left `created` for manual review.
      captureFinancialError('license_underpaid_order', { scope: 'razorpay.license_underpaid', orderId, paymentId, amount: razorpayAmountPaise })
      console.warn('[webhook/razorpay] license recovery — order does not cover its full price, left for review:', { orderId, eventId: persisted.eventId })
      return 'handled'
    }
    // Wallet-02 — purchase notifications, once per order (claim-deduplicated; never throws).
    scheduleServicePurchaseNotification(persisted.orderId)
    console.log('[webhook/razorpay] license activated via recovery:', { orderId, paymentId, eventId: persisted.eventId, result: activation.kind })
    return 'handled'
  } catch (err) {
    // RD-F3 — a GENUINE processing failure (Firestore / transaction error, a hold write that failed…).
    // It used to be returned as "not a licence order" and acknowledged with 200, so Razorpay never
    // retried and the captured payment stayed unsettled (no licensing sweep exists). The caller now
    // answers non-2xx; every step above is idempotent, so the retry completes the work exactly once.
    captureFinancialError(err, { scope: 'razorpay.license_recovery', orderId, paymentId })
    return 'retry'
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── 1. Read raw body (required for HMAC computation) ──────────────────────
  const rawBody = await req.text()
  const signature = req.headers.get('x-razorpay-signature') ?? ''

  // ── 2. Verify webhook signature ────────────────────────────────────────────
  // NOTE the `await`. This became async when signature verification moved behind the
  // provider adapter, and without it `!promise` is always false — the check would accept
  // every unsigned request while still looking correct. TypeScript does not flag `!` on a
  // Promise, so tests/unit/webhookSignatureAwaited.test.ts asserts it directly.
  if (!await verifyWebhookSignature(rawBody, signature)) {
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

  // ── 3b. refund.processed / refund.failed — sync gateway refunds to Firestore (W1) ───────
  // The documented payload: payload.refund.entity (no order_id) + payload.payment.entity (order_id).
  // Records and reconciles only — nothing here (or in the handlers) ever initiates a refund.
  if (eventType === 'refund.processed' || eventType === 'refund.failed') {
    const parsed = parseRazorpayRefundEvent(event.payload)
    if (!parsed.ok) {
      // Permanently unusable (no refund id / amount / payment id): a redelivery cannot fix it, so it is
      // acknowledged — and surfaced, never dropped silently.
      captureFinancialError(new Error(`refund webhook payload unusable: ${parsed.reason}`), { scope: 'razorpay.refund_payload_unusable', eventType, reason: parsed.reason })
      console.warn('[webhook/razorpay] refund event unusable:', { eventType, reason: parsed.reason })
      return NextResponse.json({ received: true })
    }
    try {
      if (eventType === 'refund.processed') await handleRegistrationRefund(parsed.event)
      else await handleRegistrationRefundFailed(parsed.event)
    } catch (err) {
      captureWebhookError(err, { scope: 'razorpay.refund_event_failed', eventType, razorpayRefundId: parsed.event.refundId })
      return NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
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
    const topup = topupSnap.data() as { uid: string; amountPaise: number; status: string; paymentId?: string }
    if (topup.status === 'credited') {
      if (!topup.paymentId || topup.paymentId === paymentId) {
        return NextResponse.json({ received: true })  // fast-path idempotency (same payment)
      }
      // RD-WALLET-W1 · W1.4 — a SECOND captured payment on an order that was already credited.
      // Not credited, not refunded automatically: recorded for Super Admin review. If the
      // record cannot be persisted, answer non-2xx so Razorpay redelivers (RD-F3 contract).
      const recorded = await recordDuplicateTopupPayment({
        orderId, uid: topup.uid, amountPaise: topup.amountPaise, paymentId,
        creditedPaymentId: topup.paymentId, source: 'webhook', paymentStatus: 'captured',
      })
      return recorded
        ? NextResponse.json({ received: true })
        : NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
    }
    // Amount + currency verification (defense-in-depth) before crediting the wallet.
    if (paymentCurrency !== 'INR' || paymentAmount !== topup.amountPaise) {
      captureFinancialError('wallet_topup_amount_mismatch', { scope: 'razorpay.topup_mismatch', orderId, expected: topup.amountPaise, got: paymentAmount, currency: paymentCurrency })
      // RD-WALLET-W2.b — never credited; recorded DURABLY for Super Admin review (needs_review,
      // idempotent per payment, flagged once). Only a durable record may be acknowledged: if it
      // cannot be written, answer non-2xx so Razorpay redelivers (RD-F3 contract).
      const recorded = await recordTopupPaymentMismatch({
        orderId, uid: topup.uid, paymentId,
        expectedAmountPaise: topup.amountPaise,
        observedAmountPaise: typeof paymentAmount === 'number' ? paymentAmount : null,
        expectedCurrency:    'INR',
        observedCurrency:    typeof paymentCurrency === 'string' ? paymentCurrency : null,
        source:              'webhook',
      })
      return recorded
        ? NextResponse.json({ received: true })  // recorded for review; do not credit
        : NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
    }
    // Atomic credit + status + ledger in one transaction — exactly-once via the
    // shared topup status (C-1). A transient failure records a reconciliation
    // entry so the captured payment is never lost (the cron retries idempotently).
    //
    // RD-WALLET-W1 — this event is `payment.captured`, so the money IS captured. Outcomes:
    //   • credited, or already credited with this payment      → 200;
    //   • already credited with ANOTHER payment (a race)        → duplicate recorded → 200;
    //   • refused (TopupCreditError: not creditable/conflict)   → held for review → 200;
    //   • transient failure, reconciliation record persisted    → 200 (the cron completes it);
    //   • transient failure AND the record could not persist    → 500, so Razorpay redelivers.
    //     Nothing durable exists yet, so acknowledging would lose the captured payment.
    try {
      const result = await atomicTopupCredit(topup.uid, topup.amountPaise, topupRef, paymentId)
      if (!result.credited && result.creditedPaymentId && result.creditedPaymentId !== paymentId) {
        const recorded = await recordDuplicateTopupPayment({
          orderId, uid: topup.uid, amountPaise: topup.amountPaise, paymentId,
          creditedPaymentId: result.creditedPaymentId, source: 'webhook', paymentStatus: 'captured',
        })
        return recorded
          ? NextResponse.json({ received: true })
          : NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
      }
      console.log('[webhook/razorpay] Wallet credited via recovery:', { orderId, paymentId, uid: topup.uid, amountPaise: topup.amountPaise, credited: result.credited })
    } catch (err) {
      const refused = err instanceof TopupCreditError
      if (refused) captureFinancialError(err, { scope: 'razorpay.topup_credit_refused', orderId, paymentId, code: err.code })
      const rec = await persistWalletTopupReconciliation({
        orderId, uid: topup.uid, amountPaise: topup.amountPaise, paymentId,
        error: err instanceof Error ? err.message : 'credit_failed',
        status: refused ? 'needs_review' : 'pending',
        ...(refused ? { refusal: err.code } : {}),
      })
      // RD-WALLET-W2.c — one flag per (refusal, payment): a redelivery of the same refusal adds no
      // new evidence (the record already holds it). A new payment or a different reason still
      // flags; so does an unrecorded refusal (the flag is then the only trace until redelivery).
      if (refused && rec.newEvidence) {
        await flagSuspiciousPayment({
          source: 'wallet_topup', reason: `credit_refused:${err.code}`,
          paymentId, orderId, entityId: topup.uid,
          expectedAmountPaise: topup.amountPaise, actualAmountPaise: paymentAmount,
          expectedCurrency: 'INR', actualCurrency: paymentCurrency,
        })
      }
      const recorded = rec.persisted
      if (!recorded) {
        captureFinancialError(err, { scope: 'razorpay.topup_credit_unrecorded', detail: 'CRITICAL: captured top-up neither credited nor recorded — asking Razorpay to redeliver', orderId, paymentId })
        return NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
      }
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
    // RD-F3 — a failed licence settlement is NOT acknowledged: 500 makes Razorpay redeliver, and the
    // redelivery is idempotent (paid ⇒ already; one deterministic hold per order).
    if (recovered === 'retry') {
      return NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
    }
    if (recovered === 'handled') return NextResponse.json({ received: true })
    console.warn('[webhook/razorpay] No payment intent for orderId:', orderId)
    return NextResponse.json({ received: true })
  }

  // ── 5b. RD-FIN-01: persist the ACTUAL gateway fee ─────────────────────────
  //
  // Deliberately ABOVE the idempotency return below. In the common case the client-driven
  // verify path has already settled the registration, so `intent.status` is 'paid' and
  // this handler returns at the next block — which is precisely why `gatewayFeeActualPaise`
  // had zero writers in production. The fee is independent of settlement state, so it is
  // captured here regardless of whether this delivery settles anything.
  //
  // Idempotent and write-once inside `recordActualGatewayFee`; a no-op when the payload
  // carries no fee (authorized-but-uncaptured), leaving the estimate in place.
  // AWAITED, not fire-and-forget. This handler runs on a serverless runtime where work
  // still pending when the response is returned can simply be dropped — which would lose
  // the gateway fact silently, leaving the estimate in place and the basis reading
  // "estimated" for no visible reason. `recordActualGatewayFee` never throws and is
  // write-once, so awaiting it costs one round trip and cannot fail the delivery.
  // RD-FIN-02 · B6 — only the payment that SETTLED this registration may stamp its fee on the ledger
  // row; a duplicate capture's fee must not overwrite (write-once) the real one.
  if (intent.registrationId && (!intent.paymentId || intent.paymentId === paymentId)) {
    const actualFee = extractActualGatewayFee(paymentObj as { fee?: unknown; tax?: unknown })
    if (actualFee) {
      await recordActualGatewayFee(`ptx_${intent.registrationId}`, actualFee, { paymentId })
        .catch(err => captureFinancialError(err, {
          scope: 'razorpay.actual_fee_failed', orderId, paymentId,
        }))
    }
  }

  // ── 6. Idempotency — skip if already successfully processed ───────────────
  if (intent.status === 'paid' && intent.registrationId) {
    // RD-FIN-02 · B6 — a SECOND captured payment on an already-paid order used to be acknowledged
    // and forgotten. It is now a durable review hold (never a registration, never revenue, never
    // auto-refunded). A mismatched amount/currency is flagged only — a PAID intent is never failed.
    if (paymentId && intent.paymentId && intent.paymentId !== paymentId) {
      if (paymentCurrency !== 'INR' || paymentAmount !== intent.amount) {
        await flagSuspiciousPayment({ source: 'registration', reason: 'amount_mismatch', paymentId, orderId,
          expectedAmountPaise: intent.amount, actualAmountPaise: paymentAmount, expectedCurrency: 'INR', actualCurrency: paymentCurrency })
        return NextResponse.json({ received: true })
      }
      const recorded = await recordDuplicateRegistrationPayment({ orderId, paymentId, settledPaymentId: intent.paymentId,
        settledRegistrationId: intent.registrationId, amountPaise: intent.amount, eventSlug: intent.eventSlug,
        attendeeEmail: intent.attendee.email, organizerUid: intent.organizerUid, detectedBy: 'webhook' })
      return recorded
        ? NextResponse.json({ received: true })
        : NextResponse.json({ error: 'Temporary processing failure — please retry.' }, { status: 500 })
    }
    console.log('[webhook/razorpay] Already processed — skipping:', {
      orderId, registrationId: intent.registrationId,
    })
    return NextResponse.json({ received: true })
  }

  // ═══ RD-FIN-04A · A VERIFIED CAPTURE OUTRANKS AN EARLIER FAILURE ═══════════
  //
  // This used to `return` here, and that single line stranded six real payments
  // (₹3,110.40) during the Aug-2026 peak. The trap:
  //
  //   1. attempt 1 fails → `payment.failed` → intent becomes `registration_failed`
  //   2. the attendee retries THE SAME ORDER and succeeds → `payment.captured`
  //   3. this branch returned 200, so Razorpay considered delivery successful and
  //      never retried — money captured, no registration, no refund, no alert.
  //
  // Measured gap between the failure mark and the successful capture: 28s to 198s.
  //
  // The guard is not deleted — deleting it would let a genuinely dead intent settle. It
  // is INVERTED: a terminal intent with no registration is exactly the state an orphaned
  // capture is stuck in, so it becomes a RECOVERY candidate rather than a dead end. The
  // recovery flag is passed to the same `settleCapturedRegistration` the happy path uses;
  // there is no second settlement implementation.
  //
  // Safe to pass here because the capture is already proven twice over: this request
  // carried a valid HMAC signature (checked at step 2), and the amount + currency are
  // verified against the server-written intent at step 6.6 BELOW, before any settlement.
  // Nothing client-supplied reaches this decision.
  const terminalNoRegistration =
    (intent.status === 'registration_failed' || intent.status === 'failed') && !intent.registrationId

  if ((intent.status === 'registration_failed' || intent.status === 'failed') && !terminalNoRegistration) {
    // Terminal AND already carrying a registration — settled by definition, nothing to do.
    console.log('[webhook/razorpay] Terminal intent already has a registration — skipping:', { orderId })
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
  // RD-FIN-04A: `recovery` is supplied ONLY for a terminal intent with no registration,
  // and only after the signature + amount + currency checks above. It lifts exactly two
  // things inside settleCapturedRegistration — the terminal-state guard and the
  // refund-on-timing-gate — and leaves every other eligibility rule enforced, so a
  // recovered capture still cannot bypass capacity, duplicates or an invite code.
  const outcome = await settleCapturedRegistration({
    orderId, paymentId, intent, source: 'webhook',
    ...(terminalNoRegistration ? { recovery: { verifiedCapturedPaymentId: paymentId } } : {}),
  })

  if (outcome.kind === 'settled') {
    // The 5b attempt above found no ledger row because settlement had not run yet. Retry
    // now that it has — same idempotent writer, so whichever of the two lands first wins
    // and the other reports `already_actual`.
    const actualFee = extractActualGatewayFee(paymentObj as { fee?: unknown; tax?: unknown })
    if (actualFee) {
      await recordActualGatewayFee(`ptx_${outcome.registrationId}`, actualFee, { paymentId })
        .catch(err => captureFinancialError(err, {
          scope: 'razorpay.actual_fee_post_settle_failed', orderId, paymentId,
        }))
    }
    console.log('[webhook/razorpay] Registration recovered:', {
      orderId, paymentId, registrationId: outcome.registrationId, eventSlug: intent.eventSlug,
    })
  } else if (outcome.kind === 'held') {
    // RD-PAYMENT-REFUND-AUTHORITY-02 — this branch used to read `kind === 'refunded'`. A
    // webhook can no longer cause a refund at all: a refusal parks the captured payment as a
    // review record and this reports it. The money is still with us, which is the point.
    captureWebhookError('settlement_held_after_capture', {
      scope: 'razorpay.settlement_held', orderId, paymentId, reason: outcome.reason,
      detail: 'captured payment held for Super Admin review — NOT refunded',
    })
  }

  // Always ack: Razorpay retries a non-2xx, and every outcome above is either final or
  // deliberately left for the sweep. A retry storm helps nobody.
  return NextResponse.json({ received: true })
}
