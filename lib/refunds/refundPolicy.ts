// RD-FIN-01 · Pure refund decisions. No Firestore, no network, no clock.
//
// Everything here is a function of its arguments, so the rules that actually matter —
// what counts as a duplicate, when side effects may run, whether a refund implies a
// cancellation — are testable without an emulator. `registrationRefunds.ts` owns the I/O
// and calls into this; the split is the same one `lib/fees/engine.ts` already uses.

import type {
  RegistrationRefundDocument,
  RegistrationRefundStatus,
  RecordRefundInput,
} from './types'

/**
 * May the caller apply this refund's side effects — registration update, ledger reversal,
 * wallet debit, email?
 *
 * `processed` is the ONLY terminal state. Everything else is safe to advance, which is
 * what lets an `unlinked` refund be completed later once its registration is known
 * without a second gateway refund or a second wallet debit.
 */
export function canApplySideEffects(status: RegistrationRefundStatus): boolean {
  // W1 — a FAILED refund moved no money: it can never be given a refund's side effects.
  return status !== 'processed' && status !== 'failed'
}

/** W1 — does this record represent money that actually left (counted in refund totals)? */
export function isCountedRefund(status: RegistrationRefundStatus | undefined): boolean {
  return status !== 'failed'
}

/**
 * The registration-side guard, kept separate from the refund-record guard.
 *
 * `refund_pending` means the organizer-initiated path is mid-flight and will finish the
 * ledger reversal itself; a webhook that barged in would double-debit. `refunded` means
 * it already finished. Both must stop the webhook — and both are properties of the
 * REGISTRATION, not of the refund, which is why this is not folded into the status check
 * above.
 */
export function registrationBlocksRefundSideEffects(paymentStatus: string | undefined): boolean {
  return paymentStatus === 'refunded' || paymentStatus === 'refund_pending'
}

/**
 * Status a newly recorded refund should carry.
 *
 * A refund with no resolvable registration is `unlinked`, NOT failed and NOT dropped.
 * The gateway fact is complete on its own; only the attribution is missing.
 */
export function initialStatusFor(registrationId: string | null | undefined): RegistrationRefundStatus {
  return registrationId ? 'linked' : 'unlinked'
}

/**
 * Is this refund payload usable at all?
 *
 * The refund id is the idempotency key, so a missing one is fatal — without it a retry
 * cannot be recognised as a retry and would refund twice. A missing ORDER id is not
 * fatal: it only costs us the linkage, and an unlinked record is still worth keeping.
 */
export function validateRefundInput(input: Partial<RecordRefundInput>): { ok: true } | { ok: false; reason: string } {
  if (!input.razorpayRefundId) return { ok: false, reason: 'missing_refund_id' }
  if (typeof input.amountPaise !== 'number' || !Number.isFinite(input.amountPaise)) {
    return { ok: false, reason: 'missing_amount' }
  }
  if (!Number.isInteger(input.amountPaise) || input.amountPaise < 0) {
    return { ok: false, reason: 'invalid_amount' }
  }
  return { ok: true }
}

/**
 * Does observing a refund mean the registration should be cancelled?
 *
 * NO — always, and this exists to make that answer greppable rather than implicit in the
 * absence of code. The 2026-08 reconciliation found 6 cancelled registrations never
 * refunded and 1 refunded registration still confirmed. Both are legitimate: a refund is
 * a MONEY event and a cancellation is an ATTENDANCE event, and an organizer may
 * deliberately refund a participant who still runs, or cancel one who is not owed money.
 *
 * Auto-linking the two would have silently rewritten 7 historical records.
 */
export function refundImpliesCancellation(): false {
  return false
}

/**
 * Does cancelling a registration mean a refund should be issued?
 *
 * NO, for the mirror reason. Refunds move real money and are an explicit organizer act.
 */
export function cancellationImpliesRefund(): false {
  return false
}

/**
 * Merge a later observation into an existing record.
 *
 * Records are IMMUTABLE in their financial fields — amount and gateway ids are never
 * rewritten, because a second delivery describing a different amount for the same refund
 * id means the gateway is being misread, not that the amount changed. Only linkage may be
 * filled in, and only from null.
 */
export function buildLinkagePatch(
  existing: Pick<RegistrationRefundDocument, 'registrationId' | 'eventSlug' | 'organizerUid' | 'status'>,
  resolved: { registrationId: string; eventSlug: string | null; organizerUid: string | null },
): Partial<RegistrationRefundDocument> | null {
  if (existing.registrationId) return null          // already attributed — never re-point
  return {
    registrationId: resolved.registrationId,
    eventSlug:      resolved.eventSlug,
    organizerUid:   resolved.organizerUid,
    // A terminal state is never reopened by a linkage fill-in.
    status:         existing.status === 'processed' || existing.status === 'failed' ? existing.status : 'linked',
  }
}

/**
 * Orphan detection (Phase 7) — pure set arithmetic, no gateway call and no hardcoded ids.
 *
 * Deliberately takes both sides as arguments so the caller decides where they came from
 * (a CSV during an audit, the Razorpay API during a cron). Reports only: repairing an
 * orphaned capture means inventing an attendee, which would move counters and capacity.
 */
export function findOrphanedCaptures(
  gatewayPaymentIds: readonly string[],
  knownPaymentIds:   readonly string[],
): string[] {
  const known = new Set(knownPaymentIds)
  const seen  = new Set<string>()
  const out: string[] = []
  for (const id of gatewayPaymentIds) {
    if (!id || known.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** The mirror: ledger rows the gateway does not know about. Should always be empty. */
export function findUnbackedTransactions(
  knownPaymentIds:   readonly string[],
  gatewayPaymentIds: readonly string[],
): string[] {
  const gateway = new Set(gatewayPaymentIds)
  return [...new Set(knownPaymentIds)].filter(id => id && !gateway.has(id))
}

/**
 * RD-FIN-02 · does this gateway refund complete the IN-FLIGHT Super Admin refund on this registration?
 * Evidence-only: the registration must be `refund_pending`, and the refund must be of the SAME payment
 * for the SAME amount the claim recorded (legacy claims without `refundClaim` fall back to the
 * registration's own payment id and amount). Pure.
 */
export function pendingRefundMatches(
  reg: { paymentStatus?: string; paymentId?: string; amount?: number; refundClaim?: { paymentId?: string; amountPaise?: number; kind?: unknown } },
  refund: { gatewayPaymentId: string | null; amountPaise: number },
): boolean {
  if (reg.paymentStatus !== 'refund_pending') return false
  // RD-REFUND-MANUAL-01 — a MANUAL refund's claim is never finished by a gateway refund (that would record the
  // attendee repaid by the gateway while a transfer is also being made). The webhook holds such a refund for review.
  if (reg.refundClaim?.kind === 'manual') return false
  const payId = reg.refundClaim?.paymentId ?? reg.paymentId
  const amt   = reg.refundClaim?.amountPaise ?? reg.amount
  return !!refund.gatewayPaymentId && refund.gatewayPaymentId === payId && refund.amountPaise === amt
}

// ─── W1 · Razorpay refund webhook payloads ───────────────────────────────────────

/**
 * The documented Razorpay refund webhook shape (refund.created / refund.processed / refund.failed):
 *   payload.refund.entity  — id, amount (paise), currency, payment_id, status, … — NO order_id
 *   payload.payment.entity — id, order_id, amount, currency, …  ("contains": ["refund","payment"])
 * The order is taken ONLY from the payment entity, and only when that entity is the refund's own
 * payment. A refund-entity order_id is not part of the contract and is never trusted.
 */
export interface ParsedRefundEvent {
  refundId:      string
  amountPaise:   number
  currency:      string | null
  paymentId:     string
  /** From payload.payment.entity, only when its id is the refund's payment_id. */
  orderId:       string | null
  /** The payment entity named a DIFFERENT payment than the refund: nothing may be attributed. */
  paymentMismatch: boolean
  paymentAmountPaise: number | null
  failureReason: string | null
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

export function parseRazorpayRefundEvent(payload: unknown): { ok: true; event: ParsedRefundEvent } | { ok: false; reason: string } {
  const p = (payload ?? {}) as { refund?: { entity?: Record<string, unknown> }; payment?: { entity?: Record<string, unknown> } }
  const r = p.refund?.entity
  if (!r || typeof r !== 'object') return { ok: false, reason: 'missing_refund_entity' }
  if (!isStr(r.id)) return { ok: false, reason: 'missing_refund_id' }
  if (typeof r.amount !== 'number' || !Number.isInteger(r.amount) || r.amount <= 0) return { ok: false, reason: 'invalid_amount' }
  if (!isStr(r.payment_id)) return { ok: false, reason: 'missing_payment_id' }
  const pay = p.payment?.entity
  const payId = pay && isStr(pay.id) ? pay.id : null
  const paymentMismatch = payId !== null && payId !== r.payment_id
  const orderId = !paymentMismatch && pay && isStr(pay.order_id) ? pay.order_id : null
  const failure = isStr((r as { error_description?: unknown }).error_description) ? String((r as { error_description?: unknown }).error_description)
    : isStr((r as { notes?: { reason?: unknown } }).notes?.reason) ? String((r as { notes?: { reason?: unknown } }).notes!.reason) : null
  return {
    ok: true,
    event: {
      refundId: r.id, amountPaise: r.amount, currency: isStr(r.currency) ? r.currency : null, paymentId: r.payment_id,
      orderId, paymentMismatch,
      paymentAmountPaise: pay && typeof pay.amount === 'number' && Number.isInteger(pay.amount) ? pay.amount : null,
      failureReason: failure ? failure.slice(0, 300) : null,
    },
  }
}

/**
 * W1 — cumulative refund accounting for ONE captured payment, in integer paise. Pure.
 *   duplicate     — this refund id is already counted (redelivery): nothing changes
 *   partial       — cumulative refunds stay below the charged amount
 *   full          — THIS refund brings the cumulative total exactly to the charged amount
 *   already_full  — the payment was already fully refunded before this refund
 *   exceeds       — this refund would take the total above the charged amount (contradictory)
 */
export type RefundAccumulation =
  | { kind: 'duplicate' }
  | { kind: 'partial' | 'full' | 'already_full' | 'exceeds'; priorPaise: number; totalPaise: number }

export function accumulateRefund(prior: Record<string, unknown> | undefined, refundId: string, amountPaise: number, chargedPaise: number): RefundAccumulation {
  const entries = Object.entries(prior ?? {})
  if (entries.some(([id]) => id === refundId)) return { kind: 'duplicate' }
  const priorPaise = entries.reduce((sum, [, v]) => sum + (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0), 0)
  const totalPaise = priorPaise + amountPaise
  if (priorPaise >= chargedPaise) return { kind: 'already_full', priorPaise, totalPaise }
  if (totalPaise > chargedPaise) return { kind: 'exceeds', priorPaise, totalPaise }
  return { kind: totalPaise === chargedPaise ? 'full' : 'partial', priorPaise, totalPaise }
}
