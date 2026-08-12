// Durable reconciliation for a registration's POST-COMMIT financial side effects.
// Server-only.
//
// When a registration transaction has already committed (registration + counters
// + claims durable, payment captured), the wallet credit + platform-ledger write
// must NOT be allowed to fail the request or trigger a refund — the attendee is
// validly registered. If recordPlatformTransactionAndCredit throws (transient
// Firestore error), we persist a `registrationFinancialReconciliation` record so
// the credit can be retried out of band. Retry is idempotent because
// recordPlatformTransactionAndCredit is keyed on the ledger doc id.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  recordPlatformTransactionAndCredit,
  reversePlatformTransactionAndDebit,
  type PlatformTransactionData,
  type RevenueCreditInput,
} from '@/lib/firebase/firestore/platformTransactions'
import { buildRegistrationLedgerAndCredit } from '@/lib/payments/registrationLedger'
import type { PaymentIntentRecord } from '@/lib/firebase/firestore/paymentIntents'
// RD-PAY-P0-3 — orphaned-capture recovery. The SAME settlement the webhook uses.
import { settleCapturedRegistration } from '@/lib/payments/settleCapturedRegistration'
import { razorpay } from '@/lib/razorpay/client'

const COLLECTION = 'registrationFinancialReconciliation'
const REFUND_REVERSAL_COLLECTION = 'refundLedgerReconciliation'

export interface RecordReconciliationInput {
  registrationId: string
  orderId:        string
  paymentId:      string
  ledger:         PlatformTransactionData
  credit:         RevenueCreditInput
  error:          string
}

/**
 * Persists (idempotently, keyed by registrationId) that a registration's
 * post-commit financial side effects failed. Never throws into the caller — the
 * registration must succeed regardless. `ledger` + `credit` are stored verbatim
 * (pure primitives) so the retry can replay them exactly.
 */
export async function recordRegistrationFinancialReconciliation(
  input: RecordReconciliationInput,
): Promise<void> {
  try {
    await adminDb.collection(COLLECTION).doc(input.registrationId).set(
      {
        registrationId: input.registrationId,
        orderId:        input.orderId,
        paymentId:      input.paymentId,
        organizerUid:   input.credit.organizerUid,
        ledger:         input.ledger,
        credit:         input.credit,
        status:         'pending',
        attempts:       FieldValue.increment(1),
        lastError:      input.error.slice(0, 500),
        updatedAt:      FieldValue.serverTimestamp(),
        firstSeenAt:    FieldValue.serverTimestamp(),   // merge keeps re-stamping; harmless
      },
      { merge: true },
    )
    captureFinancialError(input.error, {
      scope: 'registrationReconciliation.recorded',
      detail: 'wallet/ledger credit deferred for retry',
      registrationId: input.registrationId, orderId: input.orderId,
    })
  } catch (e) {
    // Last-resort: even the reconciliation write failed. Alert loudly; the
    // registration still stands and the daily reconciliation sweep can re-derive
    // uncredited registrations from successful payment intents if needed.
    captureFinancialError(e, {
      scope: 'registrationReconciliation.persist_failed',
      detail: 'CRITICAL: failed to persist reconciliation record',
      registrationId: input.registrationId,
    })
  }
}

// ─── Refund ledger reversal reconciliation ─────────────────────────────────────
//
// After a Razorpay refund succeeds, the registration is durably 'refunded' and
// the platform ledger reversal + wallet debit must NOT be allowed to leave the
// two inconsistent. If reversePlatformTransactionAndDebit throws (transient
// Firestore error), we persist a `refundLedgerReconciliation` record so the
// reversal can be retried out of band. Retry is idempotent because the reversal
// is keyed on the ledger doc id and no-ops once already reversed.

export interface RecordRefundReversalInput {
  registrationId: string
  ptxId:          string   // platform transaction id, e.g. `ptx_<registrationId>`
  organizerUid?:  string
  error:          string
}

/**
 * Persists (idempotently, keyed by registrationId) that a refund's ledger
 * reversal + wallet debit failed. Never throws into the caller — the Razorpay
 * refund already succeeded and the registration is validly 'refunded'.
 */
export async function recordRefundLedgerReconciliation(
  input: RecordRefundReversalInput,
): Promise<void> {
  try {
    await adminDb.collection(REFUND_REVERSAL_COLLECTION).doc(input.registrationId).set(
      {
        registrationId: input.registrationId,
        ptxId:          input.ptxId,
        ...(input.organizerUid ? { organizerUid: input.organizerUid } : {}),
        status:         'pending',
        attempts:       FieldValue.increment(1),
        lastError:      input.error.slice(0, 500),
        updatedAt:      FieldValue.serverTimestamp(),
        firstSeenAt:    FieldValue.serverTimestamp(),   // merge keeps re-stamping; harmless
      },
      { merge: true },
    )
    captureFinancialError(input.error, {
      scope: 'refundReversalReconciliation.recorded',
      detail: 'ledger reversal + wallet debit deferred for retry',
      registrationId: input.registrationId,
    })
  } catch (e) {
    captureFinancialError(e, {
      scope: 'refundReversalReconciliation.persist_failed',
      detail: 'CRITICAL: failed to persist refund reversal reconciliation record',
      registrationId: input.registrationId,
    })
  }
}

export interface RetryResult { scanned: number; resolved: number; stillPending: number }

/**
 * Drains pending reconciliation records by replaying the atomic, idempotent
 * ledger+credit. Safe to run repeatedly and concurrently: a record already
 * credited (ledger doc exists) is a no-op credit and is marked resolved.
 */
export async function retryPendingRegistrationFinancials(limitN = 100): Promise<RetryResult> {
  // Single-equality filter → automatic single-field index (no composite needed).
  const snap = await adminDb.collection(COLLECTION)
    .where('status', '==', 'pending')
    .limit(limitN)
    .get()

  let resolved = 0
  let stillPending = 0

  for (const doc of snap.docs) {
    const d = doc.data() as { ledger?: PlatformTransactionData; credit?: RevenueCreditInput }
    if (!d.ledger || !d.credit) {
      // Malformed record — mark resolved-skipped so it stops being scanned.
      await doc.ref.set({ status: 'skipped', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
      continue
    }
    try {
      await recordPlatformTransactionAndCredit(d.ledger, d.credit)   // idempotent
      await doc.ref.set(
        { status: 'resolved', resolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      resolved++
    } catch (e) {
      await doc.ref.set(
        {
          attempts:  FieldValue.increment(1),
          lastError: (e instanceof Error ? e.message : 'retry_failed').slice(0, 500),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => {})
      stillPending++
    }
  }

  return { scanned: snap.size, resolved, stillPending }
}

// ─── Post-commit ledger self-heal (RD-PAY-GA-01A) ──────────────────────────────
//
// The retry drainer above handles the case where the post-commit credit failed with a
// TRANSIENT error (a reconciliation record was written). It does NOT cover the residual
// hard-kill window: if the process dies between the registration commit and the credit —
// AND before the catch writes the reconciliation record — there is no record to drain, so
// a paid registration is left uncredited and invisible (wallet reconciliation compares the
// wallet against Σ platformTransactions, and BOTH are absent, so it detects no mismatch).
//
// This forward, cursor-bounded sweep is the promised re-derivation (see the header note
// above): it walks paymentIntents in createdAt order and repairs ONLY a `paid` intent whose
// deterministic ptx_<registrationId> is missing, reusing the SAME shared ledger build and
// the SAME idempotent recordPlatformTransactionAndCredit. It writes NOTHING else — no
// ticket, registration, receipt, counter, or duplicate ledger/credit is ever created.

// Sweep window: re-scan intents created in the last LOOKBACK, skipping the most recent
// GRACE so an in-flight post-commit credit is never mistaken for a gap. A recency-window
// RE-SCAN (NOT a forward cursor) is deliberate: a forward cursor advancing over a
// still-`created` intent would permanently skip it if it settled AND gapped later. Re-
// scanning re-examines every intent while it stays in the window, so a late-settled gap is
// always caught. Cost stays bounded by the window + limit; the daily global-reconciliation
// wallet audit is the final backstop for anything beyond the window at extreme volume.
const LEDGER_SWEEP_LOOKBACK_MS = 48 * 60 * 60 * 1000
const LEDGER_SWEEP_GRACE_MS    = 5 * 60 * 1000

export interface LedgerSweepResult {
  scanned:    number   // intents read this page
  candidates: number   // paid, positive-amount registrations examined
  recovered:  number   // missing ledgers credited directly
  enqueued:   number   // credit deferred to the retry drainer on transient failure
  alreadyOk:  number   // candidates whose ptx_ already existed
}

/**
 * Detects & repairs paid registrations missing their platform-transaction ledger.
 * Idempotent and safe to run repeatedly/concurrently: the existence pre-check + the
 * idempotent recordPlatformTransactionAndCredit (ptx_<registrationId> gate) guarantee no
 * double credit; a transient failure is handed to the existing reconciliation drainer.
 */
export async function recoverUncreditedRegistrations(limitN = 500): Promise<LedgerSweepResult> {
  const now = Date.now()
  // Newest-first range on the single (auto-indexed) createdAt field — no composite index,
  // no persisted cursor. Re-examined every run so a gap on a late-settled intent is caught.
  const snap = await adminDb.collection('paymentIntents')
    .where('createdAt', '>=', Timestamp.fromMillis(now - LEDGER_SWEEP_LOOKBACK_MS))
    .where('createdAt', '<=', Timestamp.fromMillis(now - LEDGER_SWEEP_GRACE_MS))
    .orderBy('createdAt', 'desc')
    .limit(limitN)
    .get()
  if (snap.empty) return { scanned: 0, candidates: 0, recovered: 0, enqueued: 0, alreadyOk: 0 }

  // Only PAID registrations with a positive amount post a ledger (free events do not).
  const candidates = snap.docs
    .map(d => d.data() as PaymentIntentRecord)
    .filter(i => i.status === 'paid' && typeof i.registrationId === 'string' && !!i.registrationId && (i.amount ?? 0) > 0)

  let recovered = 0, enqueued = 0, alreadyOk = 0

  if (candidates.length > 0) {
    // Cheap batch existence check — only the missing ones are recovered.
    const ptxRefs  = candidates.map(i => adminDb.collection('platformTransactions').doc(`ptx_${i.registrationId}`))
    const ptxSnaps = await adminDb.getAll(...ptxRefs)
    const missing  = candidates.filter((_, idx) => !ptxSnaps[idx].exists)
    alreadyOk = candidates.length - missing.length

    for (const intent of missing) {
      const registrationId = intent.registrationId as string
      let bundle
      try {
        bundle = await buildRegistrationLedgerAndCredit({
          registrationId,
          organizerUid:     intent.organizerUid,
          eventSlug:        intent.eventSlug,
          attendeeName:     intent.attendee?.name ?? '',
          attendeeEmail:    intent.attendee?.email ?? '',
          grossAmountPaise: intent.amount,
          paymentId:        intent.paymentId ?? '',
          orderId:          intent.orderId,
        })
      } catch (buildErr) {
        captureFinancialError(buildErr, { scope: 'ledgerSweep.build_failed', registrationId, orderId: intent.orderId })
        continue   // daily global-reconciliation wallet audit remains the final backstop
      }
      try {
        await recordPlatformTransactionAndCredit(bundle.ledger, bundle.credit)   // idempotent
        recovered++
        captureFinancialError('registration_ledger_self_healed', {
          scope:  'ledgerSweep.recovered',
          detail: 'paid registration was missing its ptx_ ledger + credit — recovered',
          registrationId, orderId: intent.orderId,
        })
      } catch (recordErr) {
        // Transient — hand off to the existing idempotent drainer (retryPendingRegistrationFinancials).
        await recordRegistrationFinancialReconciliation({
          registrationId,
          orderId:   intent.orderId,
          paymentId: intent.paymentId ?? '',
          ledger:    bundle.ledger,
          credit:    bundle.credit,
          error:     recordErr instanceof Error ? recordErr.message : 'ledger_sweep_credit_failed',
        })
        enqueued++
      }
    }
  }

  return { scanned: snap.size, candidates: candidates.length, recovered, enqueued, alreadyOk }
}

// ─── Orphaned-capture recovery (RD-PAY-P0-3) ───────────────────────────────────
//
// THE GAP THIS CLOSES. A payment is captured the moment Razorpay's checkout handler fires.
// Everything after that — the verify-payment request, its response, the browser staying
// alive — is best effort. Until now the `payment.captured` webhook was the ONLY thing that
// could notice an orphaned capture, which made a single point of failure out of a
// third-party delivery to an endpoint whose dashboard registration nobody can verify from
// inside the app (LAUNCH_CHECKLIST 2.5/2.6). If that webhook is unregistered, misconfigured,
// or simply dropped, the attendee's money is taken and no registration ever exists.
//
// This sweep is the second, independent observer. It asks Razorpay directly about intents
// that are still `created`, and settles anything Razorpay says was paid — through the SAME
// settleCapturedRegistration the webhook uses, so the two can never diverge.
//
// WHAT IT WILL NOT DO. It never marks an intent failed and never refunds on its own
// initiative. An unpaid order is left exactly as it is: `created` is not evidence of
// failure, only of silence, and a late payment against a still-open order must remain
// settleable. Razorpay being unreachable is likewise never read as "unpaid" — the intent
// stays untouched and the next run looks again.

// Recovery window. The GRACE keeps the sweep away from in-flight checkouts: an attendee
// staring at the Razorpay modal has a `created` intent and no payment yet, and asking about
// them would be pure noise. The LOOKBACK bounds cost; anything older is a manual/finance
// concern, not an automated one.
const CAPTURE_SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000
const CAPTURE_SWEEP_GRACE_MS    = 10 * 60 * 1000

export interface CaptureSweepResult {
  scanned:    number   // intents read in the window
  candidates: number   // still `created` with a positive amount
  recovered:  number   // captured at Razorpay → registration created by this sweep
  alreadyOk:  number   // raced to settled by the webhook / browser between read and settle
  refunded:   number   // captured but refused (capacity, duplicate) → refunded by policy
  unpaid:     number   // Razorpay holds nothing — left untouched, still open
  uncertain:  number   // Razorpay unreachable or settlement deferred — left recoverable
}

/**
 * Finds payment intents stuck in `created`, asks Razorpay whether money was actually taken,
 * and settles the ones that were.
 *
 * Idempotent and safe to run repeatedly and concurrently with the webhook: settlement reads
 * the intent INSIDE its transaction, so whichever caller commits first wins and every other
 * observes `paid` and no-ops. No duplicate registration, ticket, email, counter increment or
 * wallet credit is possible.
 */
export async function recoverCapturedPaymentIntents(limitN = 200): Promise<CaptureSweepResult> {
  const now = Date.now()
  const out: CaptureSweepResult = {
    scanned: 0, candidates: 0, recovered: 0, alreadyOk: 0, refunded: 0, unpaid: 0, uncertain: 0,
  }

  // Same single-field (auto-indexed) createdAt range the ledger sweep uses — no composite
  // index, no persisted cursor. Re-scanned every run so a late capture is always caught.
  const snap = await adminDb.collection('paymentIntents')
    .where('createdAt', '>=', Timestamp.fromMillis(now - CAPTURE_SWEEP_LOOKBACK_MS))
    .where('createdAt', '<=', Timestamp.fromMillis(now - CAPTURE_SWEEP_GRACE_MS))
    .orderBy('createdAt', 'desc')
    .limit(limitN)
    .get()

  out.scanned = snap.size
  if (snap.empty) return out

  const candidates = snap.docs
    .map(d => d.data() as PaymentIntentRecord)
    // RD-PAY-P0-6 — `created` is no longer the only settleable state.
    //
    // `attempt_failed` means one Razorpay attempt failed while the ORDER stayed payable;
    // the checkout retry reuses that same order, so a capture can land on it. Scanning only
    // `created` left those captures invisible to every recovery path.
    //
    // `registration_failed` is included as a REPAIR lane for intents already written by the
    // pre-fix webhook. It is NOT trusted: nothing settles on status alone — each candidate
    // is checked against Razorpay below for a payment matching this intent's OWN amount and
    // currency, and any intent carrying a refund marker is excluded outright, because a
    // refunded payment must never become a registration.
    .filter(i =>
      (i.status === 'created' || i.status === 'attempt_failed' || i.status === 'registration_failed') &&
      i.refundId === undefined && i.refundStatus === undefined &&
      (i.amount ?? 0) > 0 && typeof i.orderId === 'string' && !!i.orderId)
  out.candidates = candidates.length

  for (const intent of candidates) {
    // Ask the authority. Only a payment matching the intent's OWN amount and currency
    // counts — the same defence-in-depth check the webhook applies to its payload, so a
    // mismatched or foreign payment can never settle this registration.
    let payment: { id?: string; status?: string } | undefined
    try {
      const res = await razorpay.orders.fetchPayments(intent.orderId) as {
        items?: Array<{ id?: string; status?: string; amount?: number; currency?: string }>
      }
      payment = (res.items ?? []).find(p =>
        (p.status === 'captured' || p.status === 'authorized') &&
        p.currency === 'INR' && p.amount === intent.amount)
    } catch (err) {
      // FAIL-CLOSED: unreachable is NOT unpaid. Leave the intent alone and look again.
      captureFinancialError(err, { scope: 'captureSweep.fetch_payments_failed', detail: 'left recoverable', orderId: intent.orderId })
      out.uncertain++
      continue
    }

    if (!payment?.id) { out.unpaid++; continue }

    const outcome = await settleCapturedRegistration({
      orderId:   intent.orderId,
      paymentId: payment.id,
      intent,
      source:    'sweep',
      // Razorpay confirmed this capture above (amount + currency matched the intent).
      capturedByServer: true,
    })

    if (outcome.kind === 'settled') {
      out.recovered++
      captureFinancialError('orphaned_capture_recovered', {
        scope:  'captureSweep.recovered',
        detail: 'payment was captured at Razorpay but never settled by the browser or webhook',
        orderId: intent.orderId, paymentId: payment.id, registrationId: outcome.registrationId,
      })
    } else if (outcome.kind === 'already_settled') {
      out.alreadyOk++
    } else if (outcome.kind === 'refunded') {
      out.refunded++
    } else {
      out.uncertain++
    }
  }

  return out
}

/**
 * Drains pending refund-reversal records by replaying the atomic, idempotent
 * ledger reversal + wallet debit. Safe to run repeatedly and concurrently: a
 * ledger entry already reversed is a no-op and is marked resolved.
 */
export async function retryPendingRefundLedgerReversals(limitN = 100): Promise<RetryResult> {
  const snap = await adminDb.collection(REFUND_REVERSAL_COLLECTION)
    .where('status', '==', 'pending')
    .limit(limitN)
    .get()

  let resolved = 0
  let stillPending = 0

  for (const doc of snap.docs) {
    const d = doc.data() as { ptxId?: string }
    if (!d.ptxId) {
      await doc.ref.set({ status: 'skipped', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
      continue
    }
    try {
      await reversePlatformTransactionAndDebit(d.ptxId)   // idempotent
      await doc.ref.set(
        { status: 'resolved', resolvedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      )
      resolved++
    } catch (e) {
      await doc.ref.set(
        {
          attempts:  FieldValue.increment(1),
          lastError: (e instanceof Error ? e.message : 'retry_failed').slice(0, 500),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      ).catch(() => {})
      stillPending++
    }
  }

  return { scanned: snap.size, resolved, stillPending }
}
