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
import { authorizeWorkspace }           from '@/lib/team/workspace'
import { razorpay }                     from '@/lib/razorpay/client'
import { updatePaymentIntentRefund }    from '@/lib/firebase/firestore/paymentIntents'
import { writeAuditEntry, loadOwnedRegistration } from '@/lib/firebase/firestore/registrations'
import { reversePlatformTransactionAndDebit } from '@/lib/firebase/firestore/platformTransactions'
import { recordRefundLedgerReconciliation } from '@/lib/payments/registrationReconciliation'
import { checkRateLimit }               from '@/lib/rateLimit'
import { sendRefundEmail }              from '@/lib/registrations/sendRefundEmail'
import { releaseIdentifier }            from '@/lib/identifiers/engine'
import type { RegistrationDocument }    from '@/lib/registrations/types'
import type { PaymentIntentRecord }     from '@/lib/firebase/firestore/paymentIntents'

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
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  // GA-7B P2: a refund moves real money out (Razorpay refund + revenue-wallet
  // debit), so it must require a FINANCE permission — not the operational
  // `registrations` permission (held by manager/admin, who are denied every
  // finance permission by design). Owner (all permissions) and the finance role
  // hold `transactions`; manager/admin no longer reach this money-out path.
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

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
    await regRef.update({ paymentStatus: 'paid', updatedAt: FieldValue.serverTimestamp() })
      .catch(e => console.error('[refund] Failed to revert refund_pending to paid:', e))
    return NextResponse.json(
      { success: false, error: 'Razorpay refund failed. Please try again or contact support.' },
      { status: 502 },
    )
  }

  // ── 7. Persist successful refund ──────────────────────────────────────────
  await regRef.update({
    paymentStatus: 'refunded',
    refundId,
    refundAmount,
    refundedAt: FieldValue.serverTimestamp(),
    updatedAt:  FieldValue.serverTimestamp(),
  })

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

  // ── 8. Audit entry (fire-and-forget) ──────────────────────────────────────
  writeAuditEntry(registrationId, 'refunded', callerUid, 'organizer', uid).catch(err =>
    console.error('[refund] Failed to write audit entry:', err),
  )

  // ── 8c. Release any held identifier (fire-and-forget, idempotent). A refunded
  //        participant should not retain their identifier. ──────────────────────
  void releaseIdentifier(registrationId, callerUid, 'refunded').catch(err =>
    console.error('[refund] Failed to release identifier:', err),
  )

  // ── 9. Refund confirmation email (fire-and-forget) ────────────────────────
  sendRefundEmail(registrationId).catch(err =>
    console.error('[refund] Failed to send refund email:', err),
  )

  return NextResponse.json({ success: true, refundId, refundAmount })
}
