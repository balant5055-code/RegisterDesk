// POST /api/organizer/registrations/[registrationId]/refund
//
// Issues a full Razorpay refund for a paid registration.
//
// Idempotent by construction (RD-REGISTRATIONS-01 Phase 2 / H2): the same logical
// refund request executes AT MOST ONE gateway refund. Three layers cooperate:
//   1. an already-'refunded' registration returns its RECORDED outcome (retry → same result);
//   2. a transactional 'paid' → 'refund_pending' claim blocks concurrent double-refund;
//   3. before creating a Razorpay refund the route asks Razorpay whether this payment is
//      already refunded and REUSES that refund — so a retry after a lost/timed-out response
//      can never issue a SECOND gateway refund.

import { NextRequest, NextResponse }    from 'next/server'
import { FieldValue }                   from 'firebase-admin/firestore'
import { adminDb }           from '@/lib/firebase/admin'
import { resolveSuperAdminUid }        from '@/lib/admin/auth'
import { parseFinancialReason }        from '@/lib/admin/financialGuard'
import { logAdminActionOrRecord }      from '@/lib/admin/audit'
import { razorpay }                     from '@/lib/razorpay/client'
import { updatePaymentIntentRefund }    from '@/lib/firebase/firestore/paymentIntents'
import { writeAuditEntry, loadOwnedRegistration } from '@/lib/firebase/firestore/registrations'
import { reversePlatformTransactionAndDebit } from '@/lib/firebase/firestore/platformTransactions'
import { recordRefundLedgerReconciliation } from '@/lib/payments/registrationReconciliation'
import { ensureRegistrationRefundRecord, finalizePendingRegistrationRefund } from '@/lib/refunds/registrationRefunds'
import { checkRateLimit }               from '@/lib/rateLimit'
import { sendRefundEmail }              from '@/lib/registrations/sendRefundEmail'
import { releaseIdentifier }            from '@/lib/identifiers/engine'
// RD-BIB-TIMING-01 · the device is surrendered with the number, and goes first.
import { detachTimingTagByRegistration } from '@/lib/identifiers/timingTagEngine'
import type { RegistrationDocument }    from '@/lib/registrations/types'
import type { PaymentIntentRecord }     from '@/lib/firebase/firestore/paymentIntents'
import { readProvider }                from '@/lib/payments/providers/types'
import { captureFinancialError }       from '@/lib/monitoring/sentry'

export interface RefundRegistrationResponse {
  success:      boolean
  refundId?:    string
  refundAmount?: number
  error?:        string
}

// H2 idempotency: returns the id of an existing non-failed Razorpay refund of the given
// amount for a payment, or null if none exists. Lets the caller REUSE a refund a prior
// (timed-out) attempt already created instead of issuing a second gateway refund. On lookup
// failure returns null and falls through to create — the transactional claim + revert-on-error
// still guard concurrency, so this can only ever ADD safety, never remove it.
async function findExistingRefund(paymentId: string, amount: number): Promise<string | null> {
  try {
    const res   = await razorpay.payments.fetchMultipleRefund(paymentId)
    const items = Array.isArray(res?.items) ? res.items : []
    const match = items.find(r => r.amount === amount && r.status !== 'failed')
    return match?.id ?? null
  } catch (err) {
    console.error('[refund] existing-refund lookup failed:', { paymentId, err })
    return null
  }
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<RefundRegistrationResponse>> {
  // ── 1. Auth — SUPER ADMIN ONLY ─────────────────────────────────────────────
  //
  // RD-PAYMENT-REFUND-AUTHORITY-02. This was `authorizeWorkspace(req, 'transactions')`,
  // which GA-7B had already narrowed from the operational `registrations` permission to a
  // finance one. That was the right direction and still not far enough: `transactions` is
  // held by the workspace OWNER and by the delegated `finance` role, so an organizer could
  // return an attendee's money — and a delegate could do it on the organizer's behalf —
  // with no platform involvement.
  //
  // A refund is money leaving the platform to a third party. It is now gated on
  // `resolveSuperAdminUid`, which requires the uid to be in the ADMIN_UIDS deployment
  // configuration and not merely to carry an `admin: true` Firebase claim — a compromised
  // admin session cannot widen it, because widening it requires a deploy.
  const superAdminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!superAdminUid) {
    return NextResponse.json(
      { success: false, error: 'Refunds can only be initiated by a platform super administrator.' },
      { status: 403 },
    )
  }
  const callerUid = superAdminUid

  // RD-PHASE4-S4 · D3 — a reason (3–500 characters), checked before anything moves.
  let reqBody: { reason?: unknown } = {}
  try { reqBody = await req.json() as { reason?: unknown } } catch { reqBody = {} }
  const reasonCheck = parseFinancialReason(reqBody.reason)
  if (!reasonCheck.ok) {
    return NextResponse.json({ success: false, error: reasonCheck.error, code: reasonCheck.code }, { status: 400 })
  }
  const refundReason = reasonCheck.reason

  // The organizer is no longer derived from the caller's workspace — a super admin has
  // none. It comes from the registration itself, so every downstream write (ledger debit,
  // audit entry, wallet) still lands on the workspace that actually owns the money.
  const ownerSnap = await adminDb.collection('registrations').doc((await context.params).registrationId ?? '').get()
  if (!ownerSnap.exists) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const uid = (ownerSnap.data() as { organizerUid?: unknown }).organizerUid
  if (typeof uid !== 'string' || !uid) {
    return NextResponse.json(
      { success: false, error: 'This registration has no organizer and cannot be refunded automatically.' },
      { status: 409 },
    )
  }

  // ── 1b. Rate limit — 10 refunds per hour per organizer (H-3) ────────────────
  const rl = checkRateLimit(uid, 'organizer-refund', 10, 60 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { success: false, error: 'Too many refund requests. Please wait before retrying.' },
      { status: 429 },
    )
  }

  const { registrationId } = await context.params
  if (!registrationId) {
    return NextResponse.json({ success: false, error: 'registrationId is required' }, { status: 400 })
  }

  // ── 2. Load registration + ownership (canonical resolver, M7) ──────────────
  const owned = await loadOwnedRegistration(registrationId, uid)
  if (!owned.ok) return NextResponse.json({ success: false, error: owned.error }, { status: owned.status })
  const reg    = owned.reg
  const regRef = adminDb.collection('registrations').doc(registrationId)

  // ── 3. Guard: only paid registrations can be refunded ─────────────────────
  // Idempotent retry (H2): an ALREADY-refunded registration returns its recorded
  // outcome (persisted at step 7) rather than an error — a duplicate request (double
  // click, browser retry, refresh after a lost response) resolves to the same completed
  // refund, never a second one. No gateway call is made.
  if (reg.paymentStatus === 'refunded') {
    return NextResponse.json({
      success:      true,
      refundId:     typeof reg.refundId     === 'string' ? reg.refundId     : undefined,
      refundAmount: typeof reg.refundAmount  === 'number' ? reg.refundAmount : undefined,
    })
  }
  if (reg.paymentStatus === 'refund_pending') {
    return NextResponse.json(
      { success: false, error: 'A refund is already in progress for this registration' },
      { status: 409 },
    )
  }
  if (reg.paymentStatus !== 'paid') {
    return NextResponse.json(
      { success: false, error: 'Only paid registrations can be refunded' },
      { status: 400 },
    )
  }

  // ── 4. Find the payment intent for this registration ──────────────────────
  const piSnap = await adminDb
    .collection('paymentIntents')
    .where('registrationId', '==', registrationId)
    .limit(1)
    .get()

  if (piSnap.empty) {
    return NextResponse.json(
      { success: false, error: 'Payment record not found — cannot issue refund' },
      { status: 422 },
    )
  }

  const pi = piSnap.docs[0].data() as PaymentIntentRecord
  const { paymentId, amount: refundAmount, orderId } = pi

  // ═══ PROVIDER OWNERSHIP · THIS ROUTE REFUNDS THROUGH RAZORPAY ONLY ═════════
  //
  // Everything below calls `razorpay.payments.refund` directly. It reads the payment intent
  // but never looked at `provider`, so refunding a Cashfree registration would have handed a
  // Cashfree `cf_payment_id` to Razorpay's refund API — against the wrong gateway, for a
  // payment Razorpay has never heard of.
  //
  // It REFUSES rather than routing to Cashfree's adapter, and the distinction matters: the
  // Cashfree refund CREATE contract is verified, but nothing that resolves a refund to a
  // terminal state is. No Cashfree refund-status webhook event and no refund status value
  // set exists anywhere in this repository, so a refund opened here would sit PENDING with
  // no webhook, no poller and no reconciliation to finish it. Creating money movement we
  // cannot track is worse than declining to start it.
  //
  // `readProvider` keeps historical intents (no discriminator) reading as Razorpay, so this
  // changes nothing for any payment that exists today.
  const intentProvider = readProvider(pi.provider)
  if (intentProvider !== 'razorpay') {
    captureFinancialError('refund_provider_unsupported', {
      scope: 'refund.provider_unsupported', registrationId, orderId,
      provider: intentProvider,
      detail: 'refund declined: this route settles through Razorpay only — nothing was charged or refunded',
    })
    return NextResponse.json(
      { success: false, error: 'Refunds for this payment method are not available yet. No refund was issued.' },
      { status: 422 },
    )
  }

  if (!paymentId) {
    return NextResponse.json(
      { success: false, error: 'Razorpay payment ID not recorded — cannot issue refund' },
      { status: 422 },
    )
  }

  // ── 5. Atomic guard: claim 'refund_pending' before calling Razorpay ─────────
  // This prevents a concurrent or retry request from issuing a second Razorpay
  // refund. If two requests race past the pre-flight checks above, only one will
  // win the transaction and transition from 'paid' → 'refund_pending' (audit C-3).
  const claimed = await adminDb.runTransaction(async txn => {
    const snap   = await txn.get(regRef)
    const latest = snap.data() as RegistrationDocument
    if (latest.paymentStatus !== 'paid') return false
    txn.update(regRef, {
      paymentStatus: 'refund_pending',
      // RD-FIN-02 · the claim records WHICH payment and HOW MUCH, so the refund.processed webhook can
      // finish this refund (with evidence) if this request dies after the gateway call.
      refundClaim:   { paymentId, amountPaise: refundAmount, by: callerUid, at: FieldValue.serverTimestamp() },
      updatedAt:     FieldValue.serverTimestamp(),
    })
    return true
  })

  if (!claimed) {
    return NextResponse.json(
      { success: false, error: 'Refund cannot be processed — registration status has changed' },
      { status: 409 },
    )
  }

  // ── 6. Issue refund via Razorpay ───────────────────────────────────────────
  // Pass registrationId in notes for Razorpay-side traceability and as a
  // deterministic receipt for deduplication on the Razorpay dashboard.
  let refundId: string
  try {
    // Idempotency (H2): a PRIOR attempt for this payment may have already created a
    // Razorpay refund whose HTTP response was lost (timeout/proxy), after which step 5's
    // catch reverted the registration to 'paid' and the caller retried. Before creating a
    // NEW refund, ask Razorpay whether this payment already carries a matching refund and
    // reuse it — so a retry can never issue a SECOND gateway refund. Reuses the existing
    // razorpay.payments.fetchMultipleRefund read API (no Razorpay integration change).
    const existingRefundId = await findExistingRefund(paymentId, refundAmount)
    if (existingRefundId) {
      refundId = existingRefundId
    } else {
      const refund = await razorpay.payments.refund(paymentId, {
        amount:  refundAmount,
        speed:   'optimum',
        notes:   { registrationId, reason: 'organizer_initiated' },
        receipt: `rfnd_${registrationId}`.slice(0, 40),
      })
      refundId = refund.id
    }
  } catch (err) {
    console.error('[refund] Razorpay API error:', { registrationId, paymentId, err })
    // Revert to 'paid' so the organizer can retry — refund_pending would block future attempts.
    // RD-FIN-02 · CONDITIONAL: a gateway timeout may hide a refund that DID happen, and the webhook
    // may already have finalized it as 'refunded' — that must never be overwritten back to 'paid'.
    await adminDb.runTransaction(async tx => {
      if ((await tx.get(regRef)).get('paymentStatus') === 'refund_pending') {
        tx.update(regRef, { paymentStatus: 'paid', refundClaim: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
      }
    }).catch(e => console.error('[refund] Failed to revert refund_pending to paid:', e))
    return NextResponse.json(
      { success: false, error: 'Razorpay refund failed. Please try again or contact support.' },
      { status: 502 },
    )
  }

  // ── 7. Persist successful refund ──────────────────────────────────────────
  //
  // RD-FIN-01: the gateway record is written FIRST and keyed by the Razorpay refund id,
  // so this path and the `refund.processed` webhook converge on ONE document. Whichever
  // observes the refund first creates it; the other finds it and does not duplicate.
  // Without this, an organizer-initiated refund would exist only as three fields on the
  // registration and the webhook would later record it as if it were a separate event.
  await ensureRegistrationRefundRecord({
    razorpayRefundId: refundId,
    gatewayPaymentId: paymentId,
    gatewayOrderId:   orderId,
    amountPaise:      refundAmount,
    origin:           'organizer',
    initiatedBy:      callerUid,
    reason:           'organizer_initiated',
    registrationId,
    eventSlug:        typeof reg.eventSlug === 'string' ? reg.eventSlug : null,
    organizerUid:     typeof reg.organizerUid === 'string' ? reg.organizerUid : null,
  }).catch(err => {
    // Never fails the refund: the gateway has already returned the money, and refusing
    // here would leave the organizer retrying a refund that already happened. The
    // reconciliation surface picks up anything this drops.
    console.error('[refund] refund record write failed:', { registrationId, refundId, err })
  })

  // RD-FIN-02 · the ONE evidence-checked transition (shared with the refund.processed webhook).
  const fin = await finalizePendingRegistrationRefund(registrationId, { refundId, amountPaise: refundAmount, gatewayPaymentId: paymentId })
  if (fin === 'already_refunded') {
    // The webhook finished it first — its side effects already ran exactly once.
    return NextResponse.json({ success: true, refundId, refundAmount })
  }
  if (fin !== 'won') {
    captureFinancialError('refund_finalize_unexpected', { scope: 'refund.finalize', registrationId, refundId, fin,
      detail: 'gateway refund exists; registration not in the claimed state — reconcile manually' })
    return NextResponse.json({ success: true, refundId, refundAmount })   // money moved: report it truthfully
  }

  // Update paymentIntents (best-effort — Razorpay refund already succeeded)
  updatePaymentIntentRefund(orderId, refundId, 'processed', refundAmount).catch(err =>
    console.error('[refund] Failed to update paymentIntents:', err),
  )

  // ── 8b. Reverse platform ledger + debit organizer revenue wallet — ATOMIC ──
  // Status flip + wallet debit commit in a single Firestore transaction and are
  // idempotent: if the refund.processed webhook reverses the same ledger entry
  // concurrently, only one call debits the wallet — no double-debit. No-op if no
  // ledger entry exists (registration predates the ledger). Awaited so a failure
  // is logged rather than lost as an unhandled rejection.
  try {
    await reversePlatformTransactionAndDebit(`ptx_${registrationId}`)
  } catch (err) {
    console.error('[refund] Failed to reverse platform transaction or debit wallet:', { registrationId, err })
    // The Razorpay refund already succeeded, so the registration is validly
    // 'refunded'. Persist a durable reconciliation record so the idempotent
    // ledger reversal + wallet debit is retried out of band (cron drain) — the
    // refund and the ledger can never be left permanently inconsistent.
    await recordRefundLedgerReconciliation({
      registrationId,
      ptxId:        `ptx_${registrationId}`,
      organizerUid: uid,
      error:        err instanceof Error ? err.message : 'ledger reversal failed',
    })
  }

  // ── 8. Audit (RD-PHASE4-S4 · F4) ──────────────────────────────────────────
  // The money has already moved, so neither write may turn this into a failure. Both are
  // AWAITED (no longer detached): the registration's own audit trail names the real actor — a
  // Super Admin, not the organizer — and the platform audit row carries the actor, reason,
  // amount and gateway refund id; if THAT write fails it is durably recorded for reconciliation.
  await writeAuditEntry(registrationId, 'refunded', callerUid, 'super_admin', uid).catch(err =>
    console.error('[refund] Failed to write audit entry:', err),
  )
  await logAdminActionOrRecord({
    adminUid:    callerUid,
    actorRole:   'super_admin',
    action:      'registration.refunded',
    entityType:  'registration',
    entityId:    registrationId,
    reason:      refundReason,
    metadata:    { organizerUid: uid, refundAmountPaise: refundAmount, refundId, paymentId, orderId },
    correlation: { registrationId, refundId, paymentId, orderId, organizerUid: uid },
  })

  // ── 8c. Release any held identifier (fire-and-forget, idempotent). A refunded
  //        participant should not retain their identifier. ──────────────────────
  // RD-BIB-TIMING-01 · a refunded participant surrenders BOTH credentials, device
  // first. The identifier engine refuses a release while a device depends on the
  // number; a refund is one of the two cases where the number must go anyway, so
  // the flag is passed explicitly here rather than the guard being relaxed globally.
  void detachTimingTagByRegistration(registrationId, callerUid, 'refunded')
    .catch(err => console.error('[refund] Failed to remove timing tag:', err))
    .then(() => releaseIdentifier(registrationId, callerUid, 'refunded', { allowWhileTagged: true }))
    .catch(err => console.error('[refund] Failed to release identifier:', err))

  // ── 9. Refund confirmation email (fire-and-forget) ────────────────────────
  sendRefundEmail(registrationId).catch(err =>
    console.error('[refund] Failed to send refund email:', err),
  )

  return NextResponse.json({ success: true, refundId, refundAmount })
}
