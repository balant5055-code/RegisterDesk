// Records a payment that failed webhook-side integrity verification
// (amount / currency / order mismatch) for manual review. Server-only.
//
// Writing this record never throws into the caller — flagging must not block the
// safe "do not process" path. The presence of a suspiciousPayments document is
// the signal for an operator to investigate; nothing downstream auto-acts on it.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'

export interface SuspiciousPaymentInput {
  source:               'registration' | 'donation' | 'wallet_topup' | 'license'
  reason:               string            // e.g. 'amount_mismatch', 'amount_or_order_mismatch'
  paymentId?:           string
  orderId?:             string
  entityId?:            string            // registrationId / donationId / topup uid
  expectedAmountPaise?: number
  actualAmountPaise?:   number
  expectedCurrency?:    string
  actualCurrency?:      string
  expectedOrderId?:     string
  actualOrderId?:       string
}

export async function flagSuspiciousPayment(input: SuspiciousPaymentInput): Promise<void> {
  try {
    // Drop undefined fields — Firestore rejects undefined values.
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) if (v !== undefined) clean[k] = v

    await adminDb.collection('suspiciousPayments').add({
      ...clean,
      reviewed:  false,
      createdAt: FieldValue.serverTimestamp(),
    })
    captureFinancialError(`suspicious_payment:${input.reason}`, { scope: 'flagSuspiciousPayment.flagged', detail: 'PAYMENT FLAGGED — manual review needed', ...input })
  } catch (e) {
    captureFinancialError(e, { scope: 'flagSuspiciousPayment.persist_failed', detail: 'CRITICAL: failed to record suspicious payment', source: input.source, reason: input.reason, paymentId: input.paymentId })
  }
}
