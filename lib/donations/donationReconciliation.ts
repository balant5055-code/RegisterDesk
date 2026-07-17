// Durable reconciliation for a donation's POST-COMMIT financial side effects.
// Server-only. Exact mirror of lib/payments/registrationReconciliation.ts.
//
// When a donation transaction has already committed (status 'successful', receipt
// number burned, counters incremented, payment captured), the platform-ledger
// write + revenue-wallet credit must NOT be allowed to fail the request, roll the
// donation back, or revoke the receipt — the donor validly donated. If
// recordPlatformTransactionAndCredit throws (transient Firestore error), we
// persist a `donationFinancialReconciliation` record so the credit can be retried
// out of band. Retry is idempotent because recordPlatformTransactionAndCredit is
// keyed on the deterministic ledger doc id (`ptx_${donationId}`).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  recordPlatformTransactionAndCredit,
  type PlatformTransactionData,
  type RevenueCreditInput,
} from '@/lib/firebase/firestore/platformTransactions'

const COLLECTION = 'donationFinancialReconciliation'

export interface RecordDonationReconciliationInput {
  donationId: string
  orderId:    string
  paymentId:  string
  ledger:     PlatformTransactionData
  credit:     RevenueCreditInput
  error:      string
}

/**
 * Persists (idempotently, keyed by donationId) that a donation's post-commit
 * financial side effects failed. Never throws into the caller — the donation must
 * succeed regardless. `ledger` + `credit` are stored verbatim (pure primitives)
 * so the retry can replay them exactly.
 */
export async function recordDonationFinancialReconciliation(
  input: RecordDonationReconciliationInput,
): Promise<void> {
  try {
    await adminDb.collection(COLLECTION).doc(input.donationId).set(
      {
        donationId:   input.donationId,
        orderId:      input.orderId,
        paymentId:    input.paymentId,
        organizerUid: input.credit.organizerUid,
        ledger:       input.ledger,
        credit:       input.credit,
        status:       'pending',
        attempts:     FieldValue.increment(1),
        lastError:    input.error.slice(0, 500),
        updatedAt:    FieldValue.serverTimestamp(),
        firstSeenAt:  FieldValue.serverTimestamp(),   // merge keeps re-stamping; harmless
      },
      { merge: true },
    )
    captureFinancialError(input.error, {
      scope: 'donationReconciliation.recorded',
      detail: 'wallet/ledger credit deferred for retry',
      donationId: input.donationId, orderId: input.orderId,
    })
  } catch (e) {
    // Last-resort: even the reconciliation write failed. Alert loudly; the donation
    // still stands and a later sweep can re-derive uncredited donations if needed.
    captureFinancialError(e, {
      scope: 'donationReconciliation.persist_failed',
      detail: 'CRITICAL: failed to persist reconciliation record',
      donationId: input.donationId,
    })
  }
}

export interface RetryResult { scanned: number; resolved: number; stillPending: number }

/**
 * Drains pending reconciliation records by replaying the atomic, idempotent
 * ledger+credit. Safe to run repeatedly and concurrently: a record already
 * credited (ledger doc exists) is a no-op credit and is marked resolved.
 */
export async function retryPendingDonationFinancials(limitN = 100): Promise<RetryResult> {
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
      // Malformed record — mark skipped so it stops being scanned.
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
