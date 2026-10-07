// RD-PAY-P0-2 — may an existing registration payment intent be reused? PURE.
//
// No SDK, no Firestore, no Razorpay, so the whole rule is unit-tested directly. Mirrors
// lib/licensing/existingOrderDecision.ts, which has protected the LICENSE checkout from
// double-charge since RD-LICENSE-COUPON-FIX. Attendee registration never had the equivalent:
// every call to create-order minted a brand-new Razorpay order, so a retry after a failed
// verification produced a second order and a second charge.
//
// ═══ THE PRINCIPLE ════════════════════════════════════════════════════════════
// ONE registration attempt → ONE active order. The attempt is identified by the
// `idempotencyKey` the client already generates per attempt (and regenerates when the pass
// changes, which genuinely IS a different attempt).
//
// A captured payment always outranks this decision: the caller asks Razorpay
// (orders.fetchPayments) before minting a replacement, exactly as the license route does.

import type { PaymentIntentStatus } from '@/lib/firebase/firestore/paymentIntents'
import type { FeeModel as EngineFeeModel } from '@/lib/fees/types'

/**
 * How long a still-unpaid `created` intent may be handed back instead of minting a new
 * order. Razorpay keeps an order attemptable well beyond this; the bound exists so an
 * attendee who wandered off for an hour and returned with a changed price is not silently
 * charged the stale amount. Past the window the caller re-checks Razorpay and, only if
 * nothing was captured, supersedes.
 */
export const INTENT_REUSE_WINDOW_MS = 30 * 60 * 1000

export interface ExistingIntentSnapshot {
  status:          PaymentIntentStatus
  registrationId?: string
  /** Present once ANY refund has been initiated — makes the intent terminal. */
  refundId?:       string
  refundStatus?:   string
  /** The charged amount persisted on the intent (paise). */
  amount:          number
  passId:          string
  attendeeEmail:   string
  createdAtMs:     number | null
}

export interface AttemptRequest {
  passId:            string
  amountPaise:       number
  attendeeEmail:     string
  nowMs:             number
}

export type AttemptDecision =
  /** Already settled — hand back the registration instead of charging again. */
  | { kind: 'already_registered'; registrationId: string }
  /** The persisted order is still the right one. Return it verbatim; do NOT mint another. */
  | { kind: 'reuse_order' }
  /**
   * The persisted intent cannot be reused as-is. Before minting a replacement the caller
   * MUST ask Razorpay whether the old order was captured — `supersede` is only safe once
   * that comes back empty.
   */
  | { kind: 'supersede'; why: 'expired' | 'price_changed' | 'pass_changed' | 'different_attendee' }
  /** Terminal (failed / held / refunded). create-order STILL asks the gateway before minting (RD-FIN-01). */
  | { kind: 'new_order'; why: 'terminal' }

/**
 * Decide what to do with an intent found under this attempt's idempotency key.
 *
 * Order of the checks is load-bearing:
 *   1. paid + registrationId — nothing else can matter; the money produced a registration.
 *   2. terminal (registration_failed / any refund field). NOTE (RD-FIN-01): nothing refunds
 *      automatically any more, so a terminal intent may still hold a captured payment (a
 *      payment.failed followed by a captured retry, or a settlement HOLD). create-order
 *      therefore runs the captured-payment check on new_order exactly as on supersede.
 *   3. identity drift — a key collision, or a request that no longer matches what was
 *      stored, must never hand back another person's order.
 *   4. price / pass drift, then age.
 *   5. otherwise reuse.
 */
export function decideExistingIntent(
  intent: ExistingIntentSnapshot,
  req:    AttemptRequest,
): AttemptDecision {
  if (intent.status === 'paid' && intent.registrationId) {
    return { kind: 'already_registered', registrationId: intent.registrationId }
  }

  const terminal =
    intent.status === 'registration_failed' ||
    intent.status === 'failed' ||
    intent.refundId !== undefined ||
    intent.refundStatus !== undefined
  if (terminal) return { kind: 'new_order', why: 'terminal' }

  // A `paid` intent WITHOUT a registrationId is not settled — the transaction has not
  // committed. It is not reusable either (the order is spent), so it must go through the
  // captured-payment check like any other supersede.
  if (intent.status === 'paid') return { kind: 'supersede', why: 'price_changed' }

  if (intent.attendeeEmail.trim().toLowerCase() !== req.attendeeEmail.trim().toLowerCase()) {
    return { kind: 'supersede', why: 'different_attendee' }
  }
  if (intent.passId !== req.passId)      return { kind: 'supersede', why: 'pass_changed' }
  if (intent.amount !== req.amountPaise) return { kind: 'supersede', why: 'price_changed' }

  if (intent.createdAtMs === null || req.nowMs - intent.createdAtMs > INTENT_REUSE_WINDOW_MS) {
    return { kind: 'supersede', why: 'expired' }
  }

  return { kind: 'reuse_order' }
}

// ─── RD-EVENT-COMMERCE-05E · an in-progress attempt keeps its fee terms ────────

/**
 * The fee model an attempt STARTED with, when that attempt is still open — so a retry of the
 * same checkout (same idempotency key, pass and attendee, inside the reuse window, nothing
 * paid, refunded or failed) is priced exactly as it began even if the organizer has since
 * changed the event's Fee Collection Method. The change then reaches only NEW attempts.
 *
 * null ⇒ no open attempt, or the intent carries no fee snapshot (pricing engine off, or a
 * legacy intent): the caller uses the event's current fee model, exactly as before.
 */
export function openAttemptFeeModel(
  intent: (ExistingIntentSnapshot & { feeModel?: EngineFeeModel | null }) | null,
  req:    Omit<AttemptRequest, 'amountPaise'>,
): EngineFeeModel | null {
  if (!intent) return null
  const fm = intent.feeModel
  if (fm !== 'organizer_pays' && fm !== 'customer_pays') return null
  const open = intent.status === 'created'
    && intent.refundId === undefined && intent.refundStatus === undefined
    && intent.passId === req.passId
    && intent.attendeeEmail.trim().toLowerCase() === req.attendeeEmail.trim().toLowerCase()
    && intent.createdAtMs !== null && req.nowMs - intent.createdAtMs <= INTENT_REUSE_WINDOW_MS
  return open ? fm : null
}

// ─── Idempotency key hygiene ──────────────────────────────────────────────────

/**
 * The key is client-supplied and becomes part of a Firestore document id, so it is
 * validated rather than trusted: `/` would change the collection path, and an unbounded
 * string would exceed the 1500-byte id limit. `crypto.randomUUID()` (what the client
 * sends) passes; anything else is ignored and the request behaves exactly as it did
 * before this feature existed — a fresh order, never an error.
 */
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/

export function normalizeIdempotencyKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const k = raw.trim()
  return KEY_RE.test(k) ? k : null
}

/**
 * Claim document id. Namespaced by event so a key that leaked from one event cannot be
 * used to fetch an order belonging to another.
 */
export function attemptClaimId(eventSlug: string, idempotencyKey: string): string {
  return `${eventSlug}__${idempotencyKey}`
}
