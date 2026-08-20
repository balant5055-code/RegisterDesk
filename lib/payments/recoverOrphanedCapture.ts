// RD-RECOVER-01 · settle ONE captured payment that never became a registration.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// A UPI attempt that fails (wrong PIN, timeout) fires `payment.failed`, and the webhook marks
// the intent `registration_failed`. Razorpay orders accept MULTIPLE attempts, so a customer
// who retries and succeeds produces a `payment.captured` on the SAME order — which both the
// webhook and settleCapturedRegistration then skip, because the intent is already terminal.
// Money captured, no registration, no refund, and Razorpay sees a 200 so it never retries.
// The capture sweep cannot see it either: it only scans intents still in `created`.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// Not a fix for that bug — the webhook, the payment.failed handler and the reconciliation
// sweep are all deliberately untouched. This is the narrow, operator-invoked door for
// settling a SPECIFIC orphaned capture that has been proven captured at Razorpay.
//
// ═══ WHY ANOTHER ORDER CANNOT QUIETLY USE THIS PATH ══════════════════════════
// The caller must state, up front, exactly what it expects to find: the order, the payment,
// the amount in paise, the event slug and the pass id. Every one is re-verified — the amount
// and payment against RAZORPAY, the event and pass against the stored intent — and any single
// mismatch aborts before a byte is written. Nothing is inferred and nothing is defaulted, so
// this cannot be pointed at an arbitrary order by omission; it can only be aimed deliberately.
//
// It performs NO capture and NO refund. It never mutates Razorpay.

import { razorpay }                    from '@/lib/razorpay/client'
import { adminDb }                     from '@/lib/firebase/admin'
import { getPaymentIntent }            from '@/lib/firebase/firestore/paymentIntents'
import { settleCapturedRegistration }  from './settleCapturedRegistration'
import type { SettlementOutcome }      from './settleCapturedRegistration'

/** Everything the operator must assert before anything is settled. All are required. */
export interface OrphanedCaptureTarget {
  orderId:           string
  /** The captured payment on that order, as seen in the Razorpay dashboard. */
  paymentId:         string
  /** Charge amount in paise. Verified against BOTH Razorpay and the stored intent. */
  expectedAmountPaise: number
  expectedEventSlug: string
  expectedPassId:    string
  /**
   * The attendee phone on the intent. Checked for an existing registration on this event —
   * email is NOT sufficient, because families routinely share one address and a sibling's
   * registration would read as a false positive.
   */
  expectedPhone:     string
}

export type RecoveryOutcome =
  /** Every check passed and the existing settlement transaction ran. */
  | { ok: true;  outcome: SettlementOutcome }
  /** A verification failed. Nothing was written, nothing refunded, Razorpay untouched. */
  | { ok: false; reason: string; detail?: string }

/**
 * Verify an orphaned capture end-to-end, then settle it through the normal settlement
 * transaction.
 *
 * ═══ IDEMPOTENCY ════════════════════════════════════════════════════════════
 * Three independent layers, none of them new:
 *   1. this function refuses when a registration already exists for the order or the phone;
 *   2. `settleCapturedRegistration` returns `already_settled` when the intent is
 *      `paid` with a registrationId — checked again INSIDE the transaction, not just before;
 *   3. the transaction writes a `ticketCodeClaims` doc, so a concurrent second attempt loses
 *      the write and cannot mint a second ticket.
 * A second run therefore yields `already_settled`: no second registration, and — because the
 * wallet credit happens only on the settling run — no second wallet credit.
 */
export async function recoverOrphanedCapture(t: OrphanedCaptureTarget): Promise<RecoveryOutcome> {
  // ── 1. Razorpay is the authority on whether money was actually taken ────────
  // Same call the reconciliation sweep uses, and therefore the same credential mechanism:
  // the shared server client. The secret is never read, logged or passed around here.
  let payments: Array<{ id?: string; status?: string; amount?: number; currency?: string }>
  try {
    const res = await razorpay.orders.fetchPayments(t.orderId) as {
      items?: Array<{ id?: string; status?: string; amount?: number; currency?: string }>
    }
    payments = res.items ?? []
  } catch (err) {
    return { ok: false, reason: 'razorpay_unreachable', detail: err instanceof Error ? err.message : 'fetch failed' }
  }

  // The payment must be ON this order — fetchPayments is scoped to the order, so membership
  // is established by the lookup itself rather than by trusting the caller's pairing.
  const payment = payments.find(p => p.id === t.paymentId)
  if (!payment)                        return { ok: false, reason: 'payment_not_on_order' }
  if (payment.status !== 'captured')   return { ok: false, reason: 'payment_not_captured', detail: payment.status }
  if (payment.currency !== 'INR')      return { ok: false, reason: 'currency_mismatch', detail: payment.currency }
  if (payment.amount !== t.expectedAmountPaise) {
    return { ok: false, reason: 'razorpay_amount_mismatch', detail: `${payment.amount}` }
  }

  // ── 2. The intent must be the specific orphan we were told to recover ───────
  const intent = await getPaymentIntent(t.orderId)
  if (!intent)                                   return { ok: false, reason: 'intent_not_found' }
  if (intent.status !== 'registration_failed')   return { ok: false, reason: 'intent_not_orphaned', detail: intent.status }
  if (intent.registrationId)                     return { ok: false, reason: 'intent_already_settled', detail: intent.registrationId }
  if (intent.amount !== t.expectedAmountPaise)   return { ok: false, reason: 'intent_amount_mismatch', detail: `${intent.amount}` }
  if (intent.eventSlug !== t.expectedEventSlug)  return { ok: false, reason: 'event_mismatch', detail: intent.eventSlug }
  if (intent.passId !== t.expectedPassId)        return { ok: false, reason: 'pass_mismatch', detail: intent.passId }
  if (intent.attendee?.phone !== t.expectedPhone) {
    return { ok: false, reason: 'phone_mismatch' }
  }

  // ── 3. Nothing may already exist for this money ─────────────────────────────
  const byOrder = await adminDb.collection('registrations')
    .where('razorpayOrderId', '==', t.orderId).limit(1).get()
  if (!byOrder.empty) return { ok: false, reason: 'registration_exists', detail: byOrder.docs[0].id }

  const byPayment = await adminDb.collection('registrations')
    .where('paymentId', '==', t.paymentId).limit(1).get()
  if (!byPayment.empty) return { ok: false, reason: 'registration_exists_for_payment', detail: byPayment.docs[0].id }

  // Phone + event, never email: siblings share an address and would false-positive.
  const byPhone = await adminDb.collection('registrations')
    .where('eventSlug', '==', t.expectedEventSlug)
    .where('attendee.phone', '==', t.expectedPhone).limit(1).get()
  if (!byPhone.empty) return { ok: false, reason: 'registration_exists_for_phone', detail: byPhone.docs[0].id }

  // ── 4. Settle through the ONE existing transaction ──────────────────────────
  // No registration, ticket, counter, claim, wallet or ledger write is constructed here; the
  // settlement transaction remains the sole authority for all of them, so a recovered
  // registration is indistinguishable from a normally-settled one.
  const outcome = await settleCapturedRegistration({
    orderId:   t.orderId,
    paymentId: t.paymentId,
    intent,
    source:    'sweep',
    recovery:  { verifiedCapturedPaymentId: t.paymentId },
  })

  return { ok: true, outcome }
}
