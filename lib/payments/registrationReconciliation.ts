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
