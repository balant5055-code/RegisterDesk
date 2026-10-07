// lib/wallet/topupStatus.ts
// RD-WALLET-W1.1 follow-up — the status of ONE top-up payment, from trusted server records only.
//
// The event wizard used to clear its "do not pay again" hold when the wallet balance rose — but an
// unrelated credit (a licence refund, another top-up) raises it too. This answers the question the
// hold actually asks: "was THIS order credited with THIS payment?"
//
// Read-only: it reads walletTopups/{orderId} and the reconciliation records for that order and
// payment. It never calls the gateway, never verifies, never credits.

// RD-WALLET-W2.f.1 — 'not_credited': a Super Admin closed this payment's review WITHOUT a credit
// (never "under review" any more). The organizer is told only that it was not added to the wallet.
export type TopupPaymentState = 'credited' | 'pending' | 'needs_review' | 'duplicate_payment' | 'not_credited'

export interface TopupRecordView     { status?: unknown; paymentId?: unknown; holdResolvedAt?: unknown }
export interface ReconciliationView  { status?: unknown; paymentId?: unknown; paymentIds?: unknown; review?: unknown }

/** A record a Super Admin closed without crediting (W2.f) — not a retry's own 'resolved'. */
function closedWithoutCredit(r: ReconciliationView | null): boolean {
  if (!r || r.status !== 'resolved' || !r.review || typeof r.review !== 'object') return false
  return (r.review as { action?: unknown }).action !== 'credited'
}
const OPEN = new Set(['pending', 'needs_review', 'exhausted', 'duplicate_payment'])
const isOpen = (r: ReconciliationView | null) => typeof r?.status === 'string' && OPEN.has(r.status)
const covers = (r: ReconciliationView, paymentId: string) =>
  r.paymentId === paymentId || (Array.isArray(r.paymentIds) && r.paymentIds.includes(paymentId))

/**
 * Pure. `credited` ONLY when the order is credited AND it was credited with this exact payment.
 * An order credited with a DIFFERENT payment means this payment was a duplicate.
 */
export function resolveTopupPaymentState(
  topup:            TopupRecordView,
  paymentId:        string,
  orderRecon:       ReconciliationView | null,   // walletTopupReconciliation/{orderId}
  duplicateRecord:  ReconciliationView | null,   // walletTopupReconciliation/dup_{paymentId}
  mismatchRecord:   ReconciliationView | null = null,   // walletTopupReconciliation/mismatch_{paymentId} (W2.b)
): TopupPaymentState {
  if (duplicateRecord?.status === 'duplicate_payment') return 'duplicate_payment'
  // RD-WALLET-W2.b — this payment's amount/currency did not match its order: never credited,
  // awaiting review (any recorded mismatch status other than a future 'resolved' still reads so).
  if (mismatchRecord && mismatchRecord.status !== 'resolved') return 'needs_review'
  // RD-WALLET-W2.f.1 — this payment's own review record was closed without credit.
  if (closedWithoutCredit(duplicateRecord) || closedWithoutCredit(mismatchRecord)) return 'not_credited'
  if (topup.status === 'credited') {
    return topup.paymentId === paymentId ? 'credited' : 'duplicate_payment'
  }
  // RD-WALLET-W2.f.1 — the order's review was closed without credit: the whole order (its hold is
  // closed once none of its records is open), or the order's own record for THIS payment. A record
  // for this payment that is still open keeps it under review.
  if (!isOpen(duplicateRecord)) {
    if (topup.status === 'needs_review' && topup.holdResolvedAt) return 'not_credited'
    if (orderRecon && closedWithoutCredit(orderRecon) && covers(orderRecon, paymentId)) return 'not_credited'
  }
  // RD-WALLET-W2.c — an order that left 'pending' without a credit can never be credited
  // automatically: held for review (several captured payments, D1) or abandoned (a payment on it
  // is a LATE payment, D3). A payment against it is awaiting review — never "pending".
  if (topup.status === 'needs_review' || topup.status === 'abandoned') return 'needs_review'
  // RD-WALLET-W2.a — 'exhausted' (retry limit reached) also awaits a Super Admin decision.
  if (orderRecon?.status === 'needs_review' || orderRecon?.status === 'exhausted') return 'needs_review'
  return 'pending'
}
