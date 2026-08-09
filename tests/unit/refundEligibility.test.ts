// MC-11 · Refund admission rules. Pure — no Firestore, no config, no I/O.
//
// These rules are shared by two callers: the guard inside `createRefundRequest` and the
// organizer's dashboard, which renders them as "why not". Testing them here is what keeps
// those two honest — a dashboard offering a Refund button the server then refuses is worse
// than no button.

import { describe, it, expect } from 'vitest'
import {
  MAX_DECISION_NOTE, MIN_DECISION_NOTE, REFUND_INELIGIBLE_COPY, evaluateRefundEligibility,
  validateDecisionNote,
  type RefundEligibilityInput, type RefundIneligibleReason,
} from '@/features/media-credits/utils/refundEligibility'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

/** A purchase that passes every rule. Each test breaks exactly one thing. */
const ok: RefundEligibilityInput = {
  refundsEnabled:           true,
  refundWindowDays:         30,
  minRefundablePaise:       100,
  minRefundCredits:         0,
  maxRefundPerRequestPaise: 0,
  purchaseStatus:           'granted',
  grantedAtMs:              NOW - 5 * DAY,
  creditsRemaining:         500,
  availableCredits:         500,
  blockingRefundStatus:     null,
  hasSettledRefund:         false,
  refundAmountPaise:        45_000,
  nowMs:                    NOW,
}

const reasonFor = (patch: Partial<RefundEligibilityInput>): RefundIneligibleReason => {
  const r = evaluateRefundEligibility({ ...ok, ...patch })
  expect(r.eligible).toBe(false)
  return (r as { eligible: false; reason: RefundIneligibleReason }).reason
}

describe('evaluateRefundEligibility — the happy path', () => {
  it('accepts a fully unused, in-window, granted purchase', () => {
    expect(evaluateRefundEligibility(ok)).toEqual({ eligible: true })
  })
})

describe('the invariants that are NOT configurable', () => {
  it('refuses when the lot is empty', () => {
    // RD-MC-REFUND-V2-P2 · THE rule, now stated on the lot. Nothing left of this purchase
    // means nothing to refund, however much money is in the wallet.
    expect(reasonFor({ creditsRemaining: 0, availableCredits: 5_000 })).toBe('no_unused_credits')
    expect(reasonFor({ creditsRemaining: -3 })).toBe('no_unused_credits')
  })

  it('ACCEPTS a partially-used purchase — this is what P2 exists for', () => {
    // 500 bought, 300 left. Before P2 this was `credits_consumed`: the ledger could not
    // attribute consumption to a lot, so a part-refund price was not knowable. Phase 1's
    // FIFO lots know it.
    expect(evaluateRefundEligibility({
      ...ok, creditsRemaining: 300, availableCredits: 300,
    })).toEqual({ eligible: true })
  })

  it('refuses when an open upload is HOLDING the unused credits', () => {
    // Unused but not free. A debit is checked against `available` (balance − held), and
    // refunding credits a live session is holding would strand that session's settlement.
    expect(reasonFor({ creditsRemaining: 499, availableCredits: 100 })).toBe('credits_held')
    expect(reasonFor({ creditsRemaining: 500, availableCredits: 499 })).toBe('credits_held')
  })

  it('accepts when available EXCEEDS the lot — other credits may exist', () => {
    // A second purchase, or a grant. The rule is "this lot's credits are free", not
    // "this is the only money in the wallet".
    expect(evaluateRefundEligibility({ ...ok, availableCredits: 5_000 }).eligible).toBe(true)
  })

  it('an empty lot outranks a hold — the organizer is told the truthful reason', () => {
    // Both conditions hold when remaining is 0 and available is 0. "You have used these
    // credits" is actionable; "an upload is holding them" would be a lie.
    expect(reasonFor({ creditsRemaining: 0, availableCredits: 0 })).toBe('no_unused_credits')
  })

  it('refuses a purchase that never granted', () => {
    for (const status of ['pending', 'paid', 'failed']) {
      expect(reasonFor({ purchaseStatus: status })).toBe('purchase_not_granted')
    }
  })
})

describe('the refund window', () => {
  it('accepts inside the window', () => {
    expect(evaluateRefundEligibility({ ...ok, grantedAtMs: NOW - 29 * DAY }).eligible).toBe(true)
  })

  it('refuses outside it', () => {
    expect(reasonFor({ grantedAtMs: NOW - 31 * DAY })).toBe('outside_refund_window')
  })

  it('is measured from the GRANT, not from now', () => {
    // A purchase granted long ago is out of window however recently it was created.
    expect(reasonFor({ grantedAtMs: NOW - 400 * DAY })).toBe('outside_refund_window')
  })

  it('an ungranted purchase (grantedAtMs 0) fails closed', () => {
    // Reported as not-granted, which is the more useful of the two true statements.
    expect(reasonFor({ grantedAtMs: 0, purchaseStatus: 'pending' })).toBe('purchase_not_granted')
  })
})

describe('duplicate protection', () => {
  it('RD-MC-REFUND-V2-P3 · a SETTLED refund no longer blocks — that is the whole feature', () => {
    // 500 bought, 100 already refunded and settled, 400 left. Before P3 the settled refund
    // was in the blocking query and made the first partial refund the last one.
    expect(evaluateRefundEligibility({
      ...ok, creditsRemaining: 400, availableCredits: 400,
      blockingRefundStatus: null, hasSettledRefund: true,
    })).toEqual({ eligible: true })
  })

  it('a fully-refunded purchase says REFUNDED, not "used"', () => {
    // Both leave the lot empty. Telling an organizer their refunded credits were used is
    // false, and sends them looking for uploads that never happened.
    expect(reasonFor({ creditsRemaining: 0, hasSettledRefund: true })).toBe('already_refunded')
    expect(reasonFor({ creditsRemaining: 0, hasSettledRefund: false })).toBe('no_unused_credits')
  })

  it('refuses while an ACTIVE refund is open', () => {
    // `requested` is holding the credits; `approved` and `settling` have already spent them.
    for (const status of ['requested', 'approved', 'settling']) {
      expect(reasonFor({ blockingRefundStatus: status })).toBe('request_already_open')
    }
  })
})

describe('configurable thresholds', () => {
  it('minRefundCredits — 0 disables the check', () => {
    expect(evaluateRefundEligibility({ ...ok, minRefundCredits: 0, purchaseCredits: 1 }).eligible)
      .toBe(true)
  })

  it('minRefundCredits — measured on what REMAINS, not what was bought', () => {
    // RD-MC-REFUND-V2-P2 · the threshold now guards the refund, and the refund is the
    // remainder. A 500-credit purchase with 50 left is a 50-credit refund; testing it
    // against 500 would wave through a refund below the minimum.
    expect(reasonFor({ minRefundCredits: 100, creditsRemaining: 50, availableCredits: 50 }))
      .toBe('below_minimum_credits')
  })

  it('minRefundCredits — the boundary is inclusive', () => {
    expect(evaluateRefundEligibility({
      ...ok, minRefundCredits: 500, creditsRemaining: 500,
    }).eligible).toBe(true)
  })

  it('minRefundablePaise — refuses a refund too small to process', () => {
    expect(reasonFor({ refundAmountPaise: 99, minRefundablePaise: 100 }))
      .toBe('below_minimum_refundable')
  })

  it('maxRefundPerRequestPaise — 0 means no ceiling', () => {
    expect(evaluateRefundEligibility({
      ...ok, maxRefundPerRequestPaise: 0, refundAmountPaise: 10_000_000,
    }).eligible).toBe(true)
  })

  it('maxRefundPerRequestPaise — refuses above the ceiling', () => {
    expect(reasonFor({ maxRefundPerRequestPaise: 50_000, refundAmountPaise: 50_001 }))
      .toBe('above_maximum_refundable')
  })

  it('maxRefundPerRequestPaise — the boundary is inclusive', () => {
    expect(evaluateRefundEligibility({
      ...ok, maxRefundPerRequestPaise: 45_000, refundAmountPaise: 45_000,
    }).eligible).toBe(true)
  })

  it('refundsEnabled false refuses everything', () => {
    expect(reasonFor({ refundsEnabled: false })).toBe('refunds_disabled')
  })
})

describe('rule ORDER — the message the organizer reads', () => {
  it('"refunds are off" outranks every other refusal', () => {
    // Otherwise an organizer is told to pick a bigger purchase when no purchase would work.
    expect(reasonFor({
      refundsEnabled: false, purchaseStatus: 'failed', availableCredits: 0,
      blockingRefundStatus: 'settled', refundAmountPaise: 0,
    })).toBe('refunds_disabled')
  })

  it('an ACTIVE refund outranks an empty lot', () => {
    // A pending request is the more actionable fact: it explains where the credits went AND
    // can be cancelled. "Nothing left" would leave the organizer with no next step.
    expect(reasonFor({ blockingRefundStatus: 'requested', creditsRemaining: 0 }))
      .toBe('request_already_open')
  })

  it('an empty lot outranks the size thresholds', () => {
    expect(reasonFor({ creditsRemaining: 0, minRefundCredits: 10_000 }))
      .toBe('no_unused_credits')
  })

  it('a hold outranks the size thresholds', () => {
    // "Finish your upload" is fixable now; "buy a bigger pack" is not the problem.
    expect(reasonFor({ creditsRemaining: 500, availableCredits: 10, minRefundCredits: 10_000 }))
      .toBe('credits_held')
  })
})

describe('REFUND_INELIGIBLE_COPY', () => {
  it('every reason has a sentence', () => {
    const reasons: RefundIneligibleReason[] = [
      'refunds_disabled', 'purchase_not_granted', 'outside_refund_window',
      'already_refunded', 'request_already_open', 'no_unused_credits', 'credits_held',
      'below_minimum_credits', 'below_minimum_refundable', 'above_maximum_refundable',
    ]
    for (const r of reasons) {
      expect(REFUND_INELIGIBLE_COPY[r]).toBeTruthy()
      expect(REFUND_INELIGIBLE_COPY[r].length).toBeGreaterThan(10)
    }
  })

  it('the consumed-credits sentence states the rule, not just the refusal', () => {
    expect(REFUND_INELIGIBLE_COPY.no_unused_credits.toLowerCase())
      .toContain('only unused credits')
  })

  it('the held-credits sentence tells the organizer what to DO', () => {
    // The difference that matters: `no_unused_credits` is permanent, `credits_held` clears
    // itself the moment the upload finishes. The copy has to say so or an organizer reads a
    // temporary state as a refusal.
    const copy = REFUND_INELIGIBLE_COPY.credits_held.toLowerCase()
    expect(copy).toContain('upload')
    expect(copy).toContain('try again')
  })
})

// ─── MC-12.1 · the admin's decision note ──────────────────────────────────────

describe('validateDecisionNote', () => {
  it('is optional when the policy says so', () => {
    const r = validateDecisionNote('', false)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.note).toBeNull()
  })

  it('normalises an empty optional note to NULL, not an empty string', () => {
    // A reader must be able to tell "no note given" from "a note that says nothing".
    for (const raw of ['', '   ', undefined, null]) {
      const r = validateDecisionNote(raw, false)
      if (r.ok) expect(r.note).toBeNull()
    }
  })

  it('keeps an optional note when one is given', () => {
    const r = validateDecisionNote('  refunded as agreed  ', false)
    if (r.ok) expect(r.note).toBe('refunded as agreed')
  })

  it('refuses a missing note when the policy requires one', () => {
    for (const raw of ['', '   ', undefined, null, 'ok']) {
      expect(validateDecisionNote(raw, true).ok).toBe(false)
    }
  })

  it('accepts a required note at the minimum length', () => {
    const r = validateDecisionNote('x'.repeat(MIN_DECISION_NOTE), true)
    expect(r.ok).toBe(true)
  })

  it('trims before measuring, so whitespace cannot pad a note to length', () => {
    expect(validateDecisionNote('  a  ', true).ok).toBe(false)
  })

  it('truncates rather than refusing an over-long note', () => {
    // Losing the tail of a long note is better than losing the decision.
    const r = validateDecisionNote('y'.repeat(MAX_DECISION_NOTE + 200), true)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.note).toHaveLength(MAX_DECISION_NOTE)
  })

  it('returns the TRIMMED note, so what is stored is what was validated', () => {
    const r = validateDecisionNote('   duplicate charge   ', true)
    if (r.ok) expect(r.note).toBe('duplicate charge')
  })
})
