// F1 follow-up · the PURE rules of the settlement refund-hold review (no Firestore, no network), shared by
// lib/settlements/refundHoldReview.ts and its tests. See that file for the full policy.

export const REFUND_HOLD_OUTCOMES = ['record_review', 'lift_hold_no_refund'] as const
export type RefundHoldOutcome = typeof REFUND_HOLD_OUTCOMES[number]
export const isRefundHoldOutcome = (v: unknown): v is RefundHoldOutcome => (REFUND_HOLD_OUTCOMES as readonly unknown[]).includes(v)

/**
 * Review reasons a successful `lift_hold_no_refund` EXPLAINS: the lift is only possible when every refund of
 * the payment is recorded FAILED, nothing is counted and Razorpay shows no refund — so a partial refund that
 * failed, and the failure that un-counted it, are resolved by that evidence. Any other reason (a success after
 * a failure, a mismatch, an exceeding refund, a failure while refund_pending / after side effects…) is a
 * contradiction the lift does not explain: that review stays open.
 */
/**
 * Phase 2.2 — PURE. May the gateway refund ATTEMPTS a hold protects be concluded "no refund" by a lift?
 * Only attempts already concluded (rejected / resolved_none / linked — a linked attempt's REFUND must then
 * pass the refund rules) or OPEN ones at least `minAgeMs` old (PD-2: longer than any request can live;
 * the lift additionally requires Razorpay to show no live refund on the payment). A missing attempt
 * record, or an open attempt younger than that, blocks the lift.
 */
export function attemptLiftState(
  attemptIds: string[], attempts: Record<string, { status?: unknown; startedAt?: unknown } | undefined>, nowMs: number, minAgeMs: number,
): { block: string | null; open: string[] } {
  const open: string[] = []
  for (const id of attemptIds) {
    const a = attempts[id]
    if (!a) return { block: 'attempt_record_missing', open: [] }
    if (a.status === 'submitting' || a.status === 'unknown') {
      const t = (a.startedAt as { toMillis?: () => number } | null | undefined)?.toMillis?.()
      if (typeof t !== 'number' || nowMs - t < minAgeMs) return { block: 'attempt_too_recent', open: [] }
      open.push(id)
    } else if (a.status !== 'rejected' && a.status !== 'resolved_none' && a.status !== 'linked') {
      return { block: 'attempt_state_unknown', open: [] }
    }
  }
  return { block: null, open }
}

export const LIFT_CLOSABLE_REVIEW_REASONS: ReadonlySet<string> = new Set(['partial_refund', 'failed_after_counted'])

/** PURE — which reviewed refund records a successful lift closes, and which stay open. Only FAILED records
 *  whose every reason the lift explains are closed; records with no open review are left alone. */
export function reviewsClosedByLift(records: Array<{ id: string; status: unknown; reviewOpen?: unknown; reviewRequired?: unknown; reviewReasons?: unknown }>): { close: string[]; keepOpen: string[] } {
  const close: string[] = [], keepOpen: string[] = []
  for (const r of records) {
    const reasons = Array.isArray(r.reviewReasons) ? r.reviewReasons.map(String) : (r.reviewRequired ? [String(r.reviewRequired)] : [])
    const open = r.reviewOpen === true || (r.reviewOpen === undefined && reasons.length > 0)
    if (!open) continue
    if (r.status === 'failed' && reasons.length > 0 && reasons.every(x => LIFT_CLOSABLE_REVIEW_REASONS.has(x))) close.push(r.id)
    else keepOpen.push(r.id)
  }
  return { close: close.sort(), keepOpen: keepOpen.sort() }
}

/**
 * PURE — may the hold be lifted on RegisterDesk's own records? (The gateway lookup is a separate,
 * additional requirement checked at submit time.)
 */
export function evaluateLift(input: {
  ledgerStatus: unknown; releaseStatus: unknown; alreadyReleased: boolean
  holdRefundIds: string[]
  /** Every registrationRefunds record of this payment (whatever its id). */
  paymentRefunds: Array<{ id: string; status: unknown }>
  countedRefundsPaise: number
  /** Phase 2.2 — gateway refund ATTEMPTS this hold protects (donations), and why they block a lift (or null). */
  holdAttemptIds?: string[]
  attemptBlock?: string | null
  /** RD-REFUND-MANUAL-01 — the row is also held by a manual refund (pending, or fully refunded): never lifted here. */
  manualRefundHold?: boolean
}): { ok: true } | { ok: false; why: string } {
  if (input.manualRefundHold) return { ok: false, why: 'manual_refund_hold' }
  if (input.alreadyReleased || input.releaseStatus === 'released') return { ok: false, why: 'settlement_already_released' }
  if (input.releaseStatus !== 'held') return { ok: false, why: 'not_held' }
  if (input.ledgerStatus !== 'completed') return { ok: false, why: 'ledger_not_completed' }
  if (!input.holdRefundIds.length && !input.holdAttemptIds?.length) return { ok: false, why: 'hold_has_no_refunds' }
  if (input.attemptBlock) return { ok: false, why: input.attemptBlock }
  const byId = new Map(input.paymentRefunds.map(r => [r.id, r.status]))
  for (const id of input.holdRefundIds) {
    if (!byId.has(id)) return { ok: false, why: 'refund_record_missing' }
    if (byId.get(id) !== 'failed') return { ok: false, why: 'refund_not_failed' }
  }
  if (input.paymentRefunds.some(r => r.status !== 'failed')) return { ok: false, why: 'other_refund_counts_as_money_out' }
  if (input.countedRefundsPaise !== 0) return { ok: false, why: 'refunds_still_counted' }
  return { ok: true }
}
