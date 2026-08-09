// MC-11 · Whether a purchase may be refunded — PURE. No Firestore, no I/O.
//
// ═══ ONE RULE SET, TWO CALLERS ════════════════════════════════════════════════
// `createRefundRequest` throws on these; the organizer's dashboard renders them as "why not".
// Before this they would have been written twice — once as guards in the service, once as
// display logic in React — and the two would have drifted the first time a threshold moved.
// A dashboard that offers a Refund button the server then refuses is worse than no button.
//
// ═══ THIS FILE PRICES NOTHING ═════════════════════════════════════════════════
// It decides ELIGIBILITY only. Every rupee figure is computed by `refundMath` and reaches
// this file already calculated. The UI, in turn, only ever renders what the server sends —
// see the note in RefundRequestDialog.

import { isWithinRefundWindow } from '@/features/media-credits/utils/refundMath'

/**
 * Why a purchase cannot be refunded.
 *
 * Ordered by how the checks run, and each one is a sentence the organizer can act on — which
 * is why "purchase_not_found" is absent: an organizer never sees a purchase that is not
 * theirs, so that case is an error, not an eligibility verdict.
 */
export type RefundIneligibleReason =
  | 'refunds_disabled'
  | 'purchase_not_granted'
  | 'outside_refund_window'
  | 'already_refunded'
  | 'request_already_open'
  /** RD-MC-REFUND-V2-P2 · the lot is empty. Every credit from this purchase has been spent. */
  | 'no_unused_credits'
  /** RD-MC-REFUND-V2-P2 · unused, but locked by an upload session that has not settled. */
  | 'credits_held'
  | 'below_minimum_credits'
  | 'below_minimum_refundable'
  | 'above_maximum_refundable'

export interface RefundEligibilityInput {
  /** From config. */
  refundsEnabled:           boolean
  refundWindowDays:         number
  minRefundablePaise:       number
  minRefundCredits:         number
  /** 0 means no ceiling. */
  maxRefundPerRequestPaise: number

  /** From the purchase. */
  purchaseStatus:  string
  grantedAtMs:     number

  /**
   * RD-MC-REFUND-V2-P2 · what this purchase's LOT still holds.
   *
   * THE source of truth for how much is refundable. Not the purchase's `credits` (which
   * ignores everything spent since), not the wallet balance (which pools every purchase and
   * every grant together and so cannot say which money belongs to this one).
   */
  creditsRemaining: number

  /**
   * From the wallet, at the moment of asking. Used ONLY to detect credits locked by an open
   * session — never to size the refund. See `credits_held` below.
   */
  availableCredits: number

  /**
   * The status of an ACTIVE refund against this purchase, or null.
   *
   * RD-MC-REFUND-V2-P3 · `settled` is no longer among these. A settled partial refund leaves
   * the rest of the purchase refundable, so treating it as blocking made the first partial
   * refund the last one. Over-refunding is prevented by `creditsRemaining`.
   */
  blockingRefundStatus: string | null

  /**
   * RD-MC-REFUND-V2-P3 · has this purchase ever been refunded to completion?
   *
   * Used ONLY to choose the honest sentence when nothing is left. Without it a fully-refunded
   * purchase would be reported as `no_unused_credits` — "every credit has been used" — and
   * the organizer would go looking for uploads that never happened.
   */
  hasSettledRefund: boolean

  /** Already computed by `refundMath` — never derived here. */
  refundAmountPaise: number

  nowMs: number
}

export type RefundEligibility =
  | { eligible: true }
  | { eligible: false; reason: RefundIneligibleReason }

/**
 * Applies every admission rule, in the order the service applies them.
 *
 * Order matters for the message an organizer reads. "Refunds are switched off" must win over
 * "this purchase is too small", because the second implies the first could be fixed by
 * choosing a different purchase, and it cannot.
 */
export function evaluateRefundEligibility(input: RefundEligibilityInput): RefundEligibility {
  const no = (reason: RefundIneligibleReason): RefundEligibility => ({ eligible: false, reason })

  if (!input.refundsEnabled) return no('refunds_disabled')

  // Only a granted purchase has credits behind it. A `pending` or `paid` one may still
  // become granted, and a `failed` one never will — neither is refundable now.
  if (input.purchaseStatus !== 'granted') return no('purchase_not_granted')

  // Measured from the GRANT, not the request: the window is about how long the organizer has
  // had the credits, not how long ago they clicked buy.
  if (!isWithinRefundWindow(input.grantedAtMs, input.nowMs, input.refundWindowDays)) {
    return no('outside_refund_window')
  }

  // RD-MC-REFUND-V2-P3 · an ACTIVE refund blocks. `requested` holds the credits, `approved`
  // and `settling` have already spent them — none of the three may be joined by a second
  // request for the same purchase.
  if (input.blockingRefundStatus !== null)           return no('request_already_open')

  // ── RD-MC-REFUND-V2-P2 · what is left, and whether it is free to leave ──────
  //
  // Before P2 one comparison did both jobs: `available < purchaseCredits` refused any purchase
  // that was not wholly untouched. Partial refunds need the two questions separated, because
  // "some of it was spent" is no longer a refusal — it is the normal case.
  //
  // 1. Is there anything left? Fixed policy, never a configurable toggle: refunding a credit
  //    already spent on a photo would return money for a service delivered.
  //
  //    RD-MC-REFUND-V2-P3 · WHY the lot is empty decides which sentence is true. Refunded
  //    credits and uploaded credits both leave `creditsRemaining` at zero, and telling an
  //    organizer their refunded credits were "used" is simply false.
  if (input.creditsRemaining <= 0) {
    return no(input.hasSettledRefund ? 'already_refunded' : 'no_unused_credits')
  }

  // 2. Is it free to leave? `available` is `balance − held`, and a debit is checked against
  //    `available` (utils/ledgerMath). Credits an open upload session is holding are unused
  //    but not free — they are about to be consumed by photos already being uploaded.
  //
  //    Refunding them would not overdraw (the debit would simply be refused) but it would
  //    strand that session: its own settlement would then find the credits gone, fail, and
  //    quarantine an upload whose photos are already stored. Blocking here is the difference
  //    between "finish your upload first" and a dead upload.
  //
  //    This does NOT size the refund. The amount is `creditsRemaining` and nothing else.
  if (input.availableCredits < input.creditsRemaining) return no('credits_held')

  if (input.minRefundCredits > 0 && input.creditsRemaining < input.minRefundCredits) {
    return no('below_minimum_credits')
  }
  if (input.refundAmountPaise < input.minRefundablePaise) {
    return no('below_minimum_refundable')
  }
  if (input.maxRefundPerRequestPaise > 0
      && input.refundAmountPaise > input.maxRefundPerRequestPaise) {
    return no('above_maximum_refundable')
  }

  return { eligible: true }
}

/**
 * One sentence an organizer can act on.
 *
 * Lives beside the rules rather than in a component, so a new reason cannot be added without
 * its explanation — a `RefundIneligibleReason` with no entry here fails the exhaustiveness
 * check at compile time.
 */
export const REFUND_INELIGIBLE_COPY: Readonly<Record<RefundIneligibleReason, string>> = {
  refunds_disabled:         'Refunds are not available on this account.',
  purchase_not_granted:     'This purchase has not completed yet.',
  outside_refund_window:    'The refund window for this purchase has closed.',
  already_refunded:         'Every remaining credit from this purchase has been refunded.',
  request_already_open:     'A refund request for this purchase is already being reviewed.',
  no_unused_credits:        'Every credit from this purchase has been used. Only unused credits can be refunded.',
  credits_held:             'Some of these credits are reserved by an upload in progress. Finish or cancel it, then try again.',
  below_minimum_credits:    'Fewer unused credits remain than the minimum refundable amount.',
  below_minimum_refundable: 'The refund would be smaller than the minimum we can process.',
  above_maximum_refundable: 'This purchase is larger than the maximum for a single refund. Contact support.',
}

// ─── MC-12.1 · The admin's decision note ──────────────────────────────────────

/** Long enough to mean something to whoever reads the audit trail months later. */
export const MIN_DECISION_NOTE = 5
export const MAX_DECISION_NOTE = 500

export type DecisionNoteCheck =
  | { ok: true;  note: string | null }
  | { ok: false; message: string }

/**
 * Validates an approve/reject note against `refundNoteRequired`.
 *
 * ONE definition, used by the decide route (which enforces it) and by the admin dialogs
 * (which disable their submit button on it). Two implementations would drift the first time
 * the minimum length moved, and the dialog would offer a button the route then refuses.
 *
 * Returns the TRIMMED note, so what is stored is what was validated.
 */
export function validateDecisionNote(
  raw: unknown, required: boolean,
): DecisionNoteCheck {
  const note = typeof raw === 'string' ? raw.trim() : ''

  if (!required) {
    // Optional: empty becomes null rather than an empty string, so a reader can tell
    // "no note given" from "a note that says nothing".
    return { ok: true, note: note.length > 0 ? note.slice(0, MAX_DECISION_NOTE) : null }
  }
  if (note.length < MIN_DECISION_NOTE) {
    return { ok: false, message: `A note of at least ${MIN_DECISION_NOTE} characters is required for this decision.` }
  }
  return { ok: true, note: note.slice(0, MAX_DECISION_NOTE) }
}
