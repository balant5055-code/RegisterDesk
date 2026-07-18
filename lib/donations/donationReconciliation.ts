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

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  recordPlatformTransactionAndCredit,
  type PlatformTransactionData,
  type RevenueCreditInput,
} from '@/lib/firebase/firestore/platformTransactions'
import { buildDonationLedgerAndCredit } from '@/lib/donations/donationLedger'
import type { DonationDocument } from '@/lib/donations/types'

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

// ─── Post-commit ledger self-heal (RD-PAY-GA-01B) ──────────────────────────────
//
// Symmetric to the registration sweep (lib/payments/registrationReconciliation.ts). The
// retry drainer above covers a TRANSIENT post-commit failure (a reconciliation record was
// written). It does NOT cover the hard-kill window: if the process dies between the
// donation-status commit (status→successful, receipt burned) and the credit — AND before
// the catch writes the reconciliation record — a `successful` donation is left uncredited
// and invisible (the ledger row is absent, so the report-only wallet audit sees no
// mismatch). This recency-window sweep (NOT a forward cursor — see the registration note)
// re-derives a `successful` donation whose deterministic ptx_<donationId> is missing,
// reusing the SAME shared ledger build + idempotent recordPlatformTransactionAndCredit.
// It writes NOTHING else — no receipt, counter, donation, or duplicate ledger/credit.

const DONATION_SWEEP_LOOKBACK_MS = 48 * 60 * 60 * 1000
const DONATION_SWEEP_GRACE_MS    = 5 * 60 * 1000

export interface DonationLedgerSweepResult {
  scanned:    number
  candidates: number
  recovered:  number
  enqueued:   number
  alreadyOk:  number
}

/**
 * Detects & repairs successful donations missing their platform-transaction ledger.
 * Idempotent and safe to run repeatedly/concurrently: the existence pre-check + the
 * idempotent recordPlatformTransactionAndCredit (ptx_<donationId> gate) guarantee no
 * double credit; a transient failure is handed to the existing donation drainer.
 */
export async function recoverUncreditedDonations(limitN = 500): Promise<DonationLedgerSweepResult> {
  const now = Date.now()
  // Only successful donations carry `paidAt`; the range query naturally excludes the rest.
  // Newest-first range on the single (auto-indexed) paidAt field — no composite index.
  const snap = await adminDb.collection('donations')
    .where('paidAt', '>=', Timestamp.fromMillis(now - DONATION_SWEEP_LOOKBACK_MS))
    .where('paidAt', '<=', Timestamp.fromMillis(now - DONATION_SWEEP_GRACE_MS))
    .orderBy('paidAt', 'desc')
    .limit(limitN)
    .get()
  if (snap.empty) return { scanned: 0, candidates: 0, recovered: 0, enqueued: 0, alreadyOk: 0 }

  const candidates = snap.docs
    .map(d => ({ id: d.id, data: d.data() as DonationDocument }))
    .filter(({ data }) => data.status === 'successful' && (data.amountPaise ?? 0) > 0)

  let recovered = 0, enqueued = 0, alreadyOk = 0

  if (candidates.length > 0) {
    const ptxRefs  = candidates.map(c => adminDb.collection('platformTransactions').doc(`ptx_${c.id}`))
    const ptxSnaps = await adminDb.getAll(...ptxRefs)
    const missing  = candidates.filter((_, idx) => !ptxSnaps[idx].exists)
    alreadyOk = candidates.length - missing.length

    for (const { id: donationId, data } of missing) {
      let bundle
      try {
        bundle = await buildDonationLedgerAndCredit({
          donationId,
          organizerUid: data.organizerUid,
          campaignSlug: data.campaignSlug,
          donorName:    data.donorName,
          donorEmail:   data.donorEmail,
          isAnonymous:  data.isAnonymous,
          amountPaise:  data.amountPaise,
          paymentId:    data.razorpayPaymentId ?? '',
          orderId:      data.razorpayOrderId ?? '',
        })
      } catch (buildErr) {
        captureFinancialError(buildErr, { scope: 'donationLedgerSweep.build_failed', donationId })
        continue
      }
      try {
        await recordPlatformTransactionAndCredit(bundle.ledger, bundle.credit)   // idempotent
        recovered++
        captureFinancialError('donation_ledger_self_healed', {
          scope:  'donationLedgerSweep.recovered',
          detail: 'successful donation was missing its ptx_ ledger + credit — recovered',
          donationId,
        })
      } catch (recordErr) {
        await recordDonationFinancialReconciliation({
          donationId,
          orderId:   data.razorpayOrderId ?? '',
          paymentId: data.razorpayPaymentId ?? '',
          ledger:    bundle.ledger,
          credit:    bundle.credit,
          error:     recordErr instanceof Error ? recordErr.message : 'donation_ledger_sweep_credit_failed',
        })
        enqueued++
      }
    }
  }

  return { scanned: snap.size, candidates: candidates.length, recovered, enqueued, alreadyOk }
}
