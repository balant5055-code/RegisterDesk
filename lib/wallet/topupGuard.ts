// lib/wallet/topupGuard.ts
// RD-WALLET-W1.1 follow-up — server-side protection against a SECOND top-up while an earlier one
// is unresolved. Server-only. Reads existing records only: no new balance, ledger or schema.
//
// Why this is on the server: the event wizard's "do not pay again" hold lived in page state, so a
// reload, a new session or another client could start a second payment while the first was still
// authorised, captured-but-uncredited or under review. The top-up order route now asks this module
// first, and refuses to mint a new order while anything is unresolved.
//
// UNRESOLVED means money may already have moved and its outcome is not final:
//   • a walletTopupReconciliation record for this organizer that is still 'pending' (a captured
//     payment whose credit is being retried), 'needs_review' or 'duplicate_payment' (held for a
//     Super Admin); or
//   • a walletTopups order still 'pending' whose gateway order ALREADY HAS an authorised or
//     captured payment (paid, not yet credited — waiting for capture, the webhook or the cron);
//   • RD-WALLET-W2.c — a walletTopups order the stale sweep HELD ('needs_review': several captured
//     payments on one order). Its per-payment records block too; this is the order-level backstop.
//     An 'abandoned' order (no money after 7 days) does NOT block — a late payment on it is held
//     by its own reconciliation record.
//   • RD-WALLET-W2.f — an order whose review a Super Admin has CLOSED (`holdResolvedAt`, set once
//     none of its records is open) no longer blocks. It stays 'needs_review', so nothing automated
//     can credit it; any new evidence on it opens a new record, which blocks again.
//
// NOT unresolved: a 'pending' order with no payment at all. That is an abandoned checkout — no
// money moved — so it must never lock the organizer out (those orders stay 'pending' forever).
// Credited orders and 'resolved'/'skipped' reconciliation records are conclusive.
//
// FAIL CLOSED: if the gateway cannot be asked about a recent pending order, the top-up is refused
// ("cannot confirm"), exactly like registration checkout's captured-payment lookup
// (app/api/registrations/create-order/route.ts: a failed lookup is treated as captured).

import { adminDb } from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { resolvePaymentProvider } from '@/lib/payments/providers'

export type UnresolvedTopupReason =
  | 'credit_pending'        // reconciliation 'pending' — captured, credit being retried
  | 'needs_review'          // reconciliation 'needs_review'
  | 'duplicate_payment'     // reconciliation 'duplicate_payment'
  | 'retry_exhausted'       // reconciliation 'exhausted' (W2.a) — retry limit reached, awaiting Super Admin
  | 'paid_not_credited'     // pending order with an authorised / captured payment
  | 'status_unknown'        // the gateway could not be asked — fail closed

export interface UnresolvedTopup { orderId: string; reason: UnresolvedTopupReason }

/** Open reconciliation statuses — anything else ('resolved', 'skipped') is conclusive. */
const OPEN_RECONCILIATION: Record<string, UnresolvedTopupReason> = {
  pending:           'credit_pending',
  needs_review:      'needs_review',
  duplicate_payment: 'duplicate_payment',
  exhausted:         'retry_exhausted',    // RD-WALLET-W2.a — unresolved until a Super Admin resolves it
}

/** Bounds the per-organizer reads (single-field `uid ==` queries — no composite index needed). */
const MAX_RECORDS = 200
/** How many of the most recent pending orders are checked at the gateway (in parallel). */
const MAX_GATEWAY_CHECKS = 10

const millis = (v: unknown): number =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : 0

/** The first unresolved top-up for this organizer, or null when a new top-up is safe to start. */
export async function findUnresolvedTopup(uid: string): Promise<UnresolvedTopup | null> {
  // 1 · open reconciliation records (captured money whose outcome is not final)
  const recon = await adminDb.collection('walletTopupReconciliation').where('uid', '==', uid).limit(MAX_RECORDS).get()
  for (const d of recon.docs) {
    const x = d.data() as { status?: unknown; orderId?: unknown }
    const reason = typeof x.status === 'string' ? OPEN_RECONCILIATION[x.status] : undefined
    if (reason) return { orderId: typeof x.orderId === 'string' ? x.orderId : d.id, reason }
  }

  // 2 · pending orders that were actually paid
  const orders = await adminDb.collection('walletTopups').where('uid', '==', uid).limit(MAX_RECORDS).get()
  const held = orders.docs.find(d => {
    const o = d.data() as { status?: unknown; holdResolvedAt?: unknown }
    return o.status === 'needs_review' && !o.holdResolvedAt
  })
  if (held) return { orderId: held.id, reason: 'needs_review' }
  const pending = orders.docs
    .map(d => ({ id: d.id, data: d.data() as { status?: unknown; amountPaise?: unknown; createdAt?: unknown } }))
    .filter(o => o.data.status === 'pending')
    .sort((a, b) => millis(b.data.createdAt) - millis(a.data.createdAt))
    .slice(0, MAX_GATEWAY_CHECKS)
  if (pending.length === 0) return null

  const gateway = resolvePaymentProvider('razorpay')   // wallet top-ups are Razorpay-only (W1.7)
  const results = await Promise.all(pending.map(async o => {
    try {
      const payments = await gateway.fetchOrderPayments(o.id)
      const paid = payments.some(p => p.status === 'captured' || p.status === 'authorized')
      return paid ? { orderId: o.id, reason: 'paid_not_credited' as const } : null
    } catch (err) {
      captureFinancialError(err, { scope: 'walletTopupGuard.fetch_payments_failed', detail: 'treated as unresolved (fail-closed)', orderId: o.id })
      return { orderId: o.id, reason: 'status_unknown' as const }
    }
  }))
  return results.find(r => r !== null) ?? null
}

/** What the organizer is told. Never exposes payment identifiers or amounts. */
export const UNRESOLVED_TOPUP_MESSAGES: Record<UnresolvedTopupReason, string> = {
  credit_pending:
    'An earlier top-up was paid and is still being credited to your wallet. Please wait for it to complete instead of paying again.',
  needs_review:
    'An earlier top-up payment is being reviewed. A new top-up cannot be started until it is resolved — please contact support if this takes long.',
  duplicate_payment:
    'An additional payment on an earlier top-up is being reviewed. A new top-up cannot be started until it is resolved — please contact support if this takes long.',
  paid_not_credited:
    'An earlier top-up was paid but has not been credited yet (it may still be awaiting capture). It will be credited automatically — please do not pay again.',
  retry_exhausted:
    'An earlier top-up could not be credited automatically after repeated attempts and is awaiting review. A new top-up cannot be started until it is resolved — please contact support.',
  status_unknown:
    'We could not confirm the status of an earlier top-up right now, so a new payment was not started. Please try again in a few minutes.',
}
