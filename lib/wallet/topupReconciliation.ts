// Durable reconciliation for wallet top-ups whose credit failed transiently
// AFTER the Razorpay payment was captured + verified. Server-only.
//
// A captured top-up must never lose funds: if atomicTopupCredit throws (transient
// Firestore error) in the verify route or the webhook, we persist a record here
// and a cron retries the (idempotent) credit until it succeeds. atomicTopupCredit
// is keyed on the topup status + a deterministic ledger id, so retries can never
// double-credit.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { atomicTopupCredit } from '@/lib/firebase/firestore/wallet'

const COLLECTION = 'walletTopupReconciliation'

export interface RecordWalletReconciliationInput {
  orderId:     string
  uid:         string
  amountPaise: number
  paymentId:   string
  error:       string
}

/** Idempotent by orderId. Never throws — the caller's response must not depend on it. */
export async function recordWalletTopupReconciliation(input: RecordWalletReconciliationInput): Promise<void> {
  try {
    await adminDb.collection(COLLECTION).doc(input.orderId).set(
      {
        orderId:     input.orderId,
        uid:         input.uid,
        amountPaise: input.amountPaise,
        paymentId:   input.paymentId,
        status:      'pending',
        attempts:    FieldValue.increment(1),
        lastError:   input.error.slice(0, 500),
        updatedAt:   FieldValue.serverTimestamp(),
        firstSeenAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    captureFinancialError(input.error, { scope: 'walletTopupReconciliation.recorded', detail: 'wallet credit deferred for retry', orderId: input.orderId })
  } catch (e) {
    captureFinancialError(e, { scope: 'walletTopupReconciliation.persist_failed', detail: 'CRITICAL: failed to persist reconciliation record', orderId: input.orderId })
  }
}

export interface WalletRetryResult { scanned: number; resolved: number; stillPending: number }

/** Drains pending records by replaying the idempotent credit. Safe to run repeatedly. */
export async function retryPendingWalletTopups(limitN = 100): Promise<WalletRetryResult> {
  const snap = await adminDb.collection(COLLECTION)
    .where('status', '==', 'pending')
    .limit(limitN)
    .get()

  let resolved = 0
  let stillPending = 0

  for (const doc of snap.docs) {
    const d = doc.data() as { orderId?: string; uid?: string; amountPaise?: number; paymentId?: string }
    if (!d.orderId || !d.uid || typeof d.amountPaise !== 'number' || !d.paymentId) {
      await doc.ref.set({ status: 'skipped', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
      continue
    }
    try {
      const topupRef = adminDb.collection('walletTopups').doc(d.orderId)
      await atomicTopupCredit(d.uid, d.amountPaise, topupRef, d.paymentId)   // idempotent
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
