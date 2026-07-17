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

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  recordPlatformTransactionAndCredit,
  reversePlatformTransactionAndDebit,
  type PlatformTransactionData,
  type RevenueCreditInput,
} from '@/lib/firebase/firestore/platformTransactions'

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
