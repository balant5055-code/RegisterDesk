// F1 follow-up — the pure rules of the settlement refund-hold review: which outcomes exist, and when a
// hold may be lifted (only on RegisterDesk's own proof that no refund money left).

import { describe, it, expect } from 'vitest'
import { evaluateLift, isRefundHoldOutcome, REFUND_HOLD_OUTCOMES, reviewsClosedByLift, attemptLiftState } from '@/lib/settlements/refundHoldRules'

const ok = { ledgerStatus: 'completed', releaseStatus: 'held', alreadyReleased: false, holdRefundIds: ['r1'], paymentRefunds: [{ id: 'r1', status: 'failed' }], countedRefundsPaise: 0 }

describe('refund-hold outcomes', () => {
  it('offers ONLY review and the evidence-gated lift — never a release / debit / absorb outcome', () => {
    expect([...REFUND_HOLD_OUTCOMES]).toEqual(['record_review', 'lift_hold_no_refund'])
    for (const o of ['release_anyway', 'release', 'debit_organizer', 'absorb_loss', 'force_release', '', null, undefined, 1]) expect(isRefundHoldOutcome(o)).toBe(false)
  })
})

describe('evaluateLift', () => {
  it('lifts only when every held refund FAILED, nothing else counts as money out, and the funds are still held + completed', () => {
    expect(evaluateLift(ok)).toEqual({ ok: true })
  })
  it('refuses every other state, naming why', () => {
    expect(evaluateLift({ ...ok, alreadyReleased: true })).toEqual({ ok: false, why: 'settlement_already_released' })
    expect(evaluateLift({ ...ok, releaseStatus: 'released' })).toEqual({ ok: false, why: 'settlement_already_released' })
    expect(evaluateLift({ ...ok, releaseStatus: 'pending' })).toEqual({ ok: false, why: 'not_held' })
    expect(evaluateLift({ ...ok, ledgerStatus: 'refunded' })).toEqual({ ok: false, why: 'ledger_not_completed' })
    expect(evaluateLift({ ...ok, holdRefundIds: [] })).toEqual({ ok: false, why: 'hold_has_no_refunds' })
    expect(evaluateLift({ ...ok, paymentRefunds: [] })).toEqual({ ok: false, why: 'refund_record_missing' })
    expect(evaluateLift({ ...ok, paymentRefunds: [{ id: 'r1', status: 'linked' }] })).toEqual({ ok: false, why: 'refund_not_failed' })
    expect(evaluateLift({ ...ok, paymentRefunds: [{ id: 'r1', status: 'processed' }] })).toEqual({ ok: false, why: 'refund_not_failed' })
    expect(evaluateLift({ ...ok, paymentRefunds: [{ id: 'r1', status: 'failed' }, { id: 'r2', status: 'linked' }] })).toEqual({ ok: false, why: 'other_refund_counts_as_money_out' })
    expect(evaluateLift({ ...ok, countedRefundsPaise: 100 })).toEqual({ ok: false, why: 'refunds_still_counted' })
  })
})

describe('reviewsClosedByLift', () => {
  it('closes only FAILED records whose every reason the lift explains (partial refund that failed, its un-counting)', () => {
    expect(reviewsClosedByLift([
      { id: 'a', status: 'failed', reviewOpen: true, reviewReasons: ['partial_refund', 'failed_after_counted'] },
      { id: 'b', status: 'failed', reviewOpen: true, reviewReasons: ['failed_after_counted'] },
    ])).toEqual({ close: ['a', 'b'], keepOpen: [] })
  })
  it('keeps contradictions, non-failed records and unexplained reasons OPEN; ignores records with no open review', () => {
    expect(reviewsClosedByLift([
      { id: 'c', status: 'failed', reviewOpen: true, reviewReasons: ['partial_refund', 'processed_after_failed'] },
      { id: 'd', status: 'failed', reviewOpen: true, reviewReasons: ['failed_while_pending'] },
      { id: 'e', status: 'linked', reviewOpen: true, reviewReasons: ['partial_refund'] },
      { id: 'f', status: 'failed', reviewOpen: false, reviewReasons: ['partial_refund'] },   // already closed
      { id: 'g', status: 'failed' },                                                          // never reviewed
      { id: 'h', status: 'failed', reviewRequired: 'partial_refund' },                        // legacy: open, no reviewOpen flag
    ])).toEqual({ close: ['h'], keepOpen: ['c', 'd', 'e'] })
  })
})

describe('Phase 2.2 · gateway refund attempts in a lift', () => {
  const MIN = 15 * 60_000
  const at = (msAgo: number) => ({ toMillis: () => 1_000_000_000 - msAgo })
  const now = 1_000_000_000
  it('an OPEN attempt younger than the PD-2 age, a missing attempt record, or an unknown state blocks the lift', () => {
    expect(attemptLiftState(['a'], { a: { status: 'unknown', startedAt: at(MIN - 1) } }, now, MIN)).toEqual({ block: 'attempt_too_recent', open: [] })
    expect(attemptLiftState(['a'], { a: { status: 'submitting', startedAt: null } }, now, MIN)).toEqual({ block: 'attempt_too_recent', open: [] })
    expect(attemptLiftState(['a'], {}, now, MIN)).toEqual({ block: 'attempt_record_missing', open: [] })
    expect(attemptLiftState(['a'], { a: { status: 'weird' } }, now, MIN)).toEqual({ block: 'attempt_state_unknown', open: [] })
  })
  it('concluded attempts pass; open attempts old enough are listed for resolution as no-refund', () => {
    expect(attemptLiftState(['a', 'b', 'c', 'd'], {
      a: { status: 'rejected' }, b: { status: 'resolved_none' }, c: { status: 'linked' }, d: { status: 'unknown', startedAt: at(MIN) },
    }, now, MIN)).toEqual({ block: null, open: ['d'] })
  })
  it('evaluateLift: a hold with only attempts is not "empty"; an attempt block refuses', () => {
    const base = { ledgerStatus: 'completed', releaseStatus: 'held', alreadyReleased: false, holdRefundIds: [], paymentRefunds: [], countedRefundsPaise: 0 }
    expect(evaluateLift(base)).toEqual({ ok: false, why: 'hold_has_no_refunds' })
    expect(evaluateLift({ ...base, holdAttemptIds: ['a'] })).toEqual({ ok: true })
    expect(evaluateLift({ ...base, holdAttemptIds: ['a'], attemptBlock: 'attempt_too_recent' })).toEqual({ ok: false, why: 'attempt_too_recent' })
    expect(evaluateLift({ ...base, holdAttemptIds: ['a'], countedRefundsPaise: 100 })).toEqual({ ok: false, why: 'refunds_still_counted' })
  })
})
