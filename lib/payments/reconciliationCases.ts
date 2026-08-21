// RD-PAY-RECON-02 · the durable record of a payment/registration mismatch.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The Phase-1 sweep already asks Razorpay the only question that matters — "was this order
// actually paid?" — and already knows the answer for every candidate. It then threw that
// answer away: `CaptureSweepResult` is counters, returned to the cron and discarded.
//
// That left an organizer surface impossible to build honestly. `paymentIntents` records that
// a payment ATTEMPT failed; it cannot distinguish "the card was declined and no money exists"
// from "the retry succeeded and we owe this person a registration" — 0 of 137 candidate
// intents carry a paymentId, because the intent is written before any payment id exists.
// A UI over that data would list ~69 rows of which ~6 were real, and would have to call
// Razorpay once per row to tell them apart.
//
// So the verdict is written down, once, by the process that already computed it.
//
// ═══ WHAT THIS IS NOT ════════════════════════════════════════════════════════
// Not a second payment ledger and not a source of truth about money. `paymentIntents`,
// `registrations` and `platformTransactions` remain authoritative; this is a derived index
// over them, safe to delete and rebuild by re-running the sweep. Nothing reads a balance
// from here and nothing settles from here — settlement goes through the one existing
// transaction, as it always has.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export const RECONCILIATION_CASES = 'paymentReconciliationCases'

/** What Razorpay said, the last time we asked. */
export type CasePaymentState =
  /** Razorpay holds a captured/authorized payment matching this order's amount and currency. */
  | 'captured'
  /** Razorpay holds nothing matching. No money exists — never shown to an organizer. */
  | 'not_captured'
  /** Razorpay could not be reached. Indeterminate — NEVER read as "not captured". */
  | 'unverified'

export type CaseStatus =
  /** Money exists, no registration, and every deterministic check says it is recoverable. */
  | 'actionable'
  /** Money may exist but recovery is blocked or unverified. Platform review, not self-serve. */
  | 'requires_review'
  /** A registration exists. Kept for history; no longer actionable. */
  | 'resolved'

export interface ReconciliationCase {
  orderId:        string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  /** SERVER-SIDE ONLY. Never returned by an organizer route — see toOrganizerView. */
  attendeePhone:  string
  amountPaise:    number
  currency:       string
  paymentState:   CasePaymentState
  /** Server-derived from Razorpay. NEVER accepted from a browser. */
  paymentId:      string | null
  status:         CaseStatus
  /** A stable symbol, never prose and never a stack trace. */
  reason:         string
  registrationId: string | null
  detectedAt:     Timestamp
  lastCheckedAt:  Timestamp
  resolvedAt:     Timestamp | null
}

/**
 * The projection an organizer may see.
 *
 * `attendeePhone` and `paymentId` are deliberately absent. The phone is PII the organizer
 * already holds elsewhere under its own permission, and this page has no use for it — the
 * server matches on it internally. The Razorpay payment id is an internal identifier whose
 * only purpose here would be to invite someone to type one in.
 */
export interface OrganizerCaseView {
  orderId:        string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  amountPaise:    number
  currency:       string
  paymentState:   CasePaymentState
  status:         CaseStatus
  reason:         string
  registrationId: string | null
  detectedAt:     string | null
  resolvedAt:     string | null
}

const iso = (t: unknown): string | null =>
  t instanceof Timestamp ? t.toDate().toISOString() : null

export function toOrganizerView(c: ReconciliationCase): OrganizerCaseView {
  return {
    orderId:        c.orderId,
    eventSlug:      c.eventSlug,
    eventName:      c.eventName,
    attendeeName:   c.attendeeName,
    amountPaise:    c.amountPaise,
    currency:       c.currency,
    paymentState:   c.paymentState,
    status:         c.status,
    reason:         c.reason,
    registrationId: c.registrationId,
    detectedAt:     iso(c.detectedAt),
    resolvedAt:     iso(c.resolvedAt),
  }
}

/** Everything the sweep knows at the moment it classifies one candidate. */
export interface CaseUpsert {
  orderId:        string
  organizerUid:   string
  eventSlug:      string
  eventName:      string
  attendeeName:   string
  attendeePhone:  string
  amountPaise:    number
  currency:       string
  paymentState:   CasePaymentState
  paymentId:      string | null
  status:         CaseStatus
  reason:         string
  registrationId?: string | null
}

/**
 * Records (or refreshes) one case. Keyed by orderId, so re-running the sweep converges
 * instead of accumulating — the same property that makes the sweep itself safe to repeat.
 *
 * `detectedAt` is written only on creation, so the age an organizer sees is when the problem
 * FIRST appeared, not when it was last looked at. `resolvedAt` is stamped only on the
 * transition into `resolved`, so a re-run cannot keep moving it.
 *
 * Best-effort by contract: this is a derived index. A write failure must never fail the
 * sweep, because the sweep's real job — settling the payment — has already happened by then.
 */
export async function upsertReconciliationCase(c: CaseUpsert): Promise<void> {
  const ref = adminDb.collection(RECONCILIATION_CASES).doc(c.orderId)
  try {
    const snap = await ref.get()
    const existing = snap.exists ? (snap.data() as Partial<ReconciliationCase>) : null

    await ref.set({
      orderId:        c.orderId,
      organizerUid:   c.organizerUid,
      eventSlug:      c.eventSlug,
      eventName:      c.eventName,
      attendeeName:   c.attendeeName,
      attendeePhone:  c.attendeePhone,
      amountPaise:    c.amountPaise,
      currency:       c.currency,
      paymentState:   c.paymentState,
      paymentId:      c.paymentId,
      status:         c.status,
      reason:         c.reason,
      registrationId: c.registrationId ?? existing?.registrationId ?? null,
      detectedAt:     existing?.detectedAt ?? FieldValue.serverTimestamp(),
      lastCheckedAt:  FieldValue.serverTimestamp(),
      resolvedAt:
        c.status === 'resolved'
          ? (existing?.status === 'resolved' ? existing.resolvedAt : FieldValue.serverTimestamp())
          : null,
    }, { merge: true })
  } catch {
    // Swallowed deliberately. See the contract note above: the money outcome is already
    // durable in paymentIntents/registrations; losing the index entry costs a UI row until
    // the next tick rewrites it.
  }
}
