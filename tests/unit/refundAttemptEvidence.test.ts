// Phase 3 · G9 — the pure classification of Razorpay's refund list for one unresolved attempt.

import { describe, it, expect } from 'vitest'
import { evaluateAttemptEvidence } from '@/lib/donations/refundAttemptEvidence'

const A = 'att_0123456789abcdef'
const list = (...items: unknown[]) => ({ entity: 'collection', count: items.length, items })
const known = new Set(['rfnd_known'])

describe('evaluateAttemptEvidence', () => {
  it('a refund carrying the attempt id links to it — whatever its status (a failed one is never "none")', () => {
    expect(evaluateAttemptEvidence(list({ id: 'rfnd_x', status: 'processed', amount: 300, notes: { attemptId: A } }), A, known))
      .toEqual({ kind: 'linked', refundId: 'rfnd_x', status: 'processed', amountPaise: 300 })
    expect(evaluateAttemptEvidence(list({ id: 'rfnd_f', status: 'failed', amount: 300, notes: { attemptId: A } }), A, known))
      .toMatchObject({ kind: 'linked', refundId: 'rfnd_f', status: 'failed' })
  })
  it('none: a complete list where every refund is already recorded (or the list is empty)', () => {
    expect(evaluateAttemptEvidence(list(), A, known)).toEqual({ kind: 'none', listedRefunds: 0 })
    expect(evaluateAttemptEvidence(list({ id: 'rfnd_known', status: 'processed', amount: 1, notes: {} }), A, known)).toEqual({ kind: 'none', listedRefunds: 1 })
  })
  it('contradictory: two refunds claim the attempt, or an UNRECORDED refund exists on the payment (any status)', () => {
    expect(evaluateAttemptEvidence(list(
      { id: 'r1', status: 'processed', notes: { attemptId: A } }, { id: 'r2', status: 'processed', notes: { attemptId: A } },
    ), A, known)).toEqual({ kind: 'contradictory', why: 'multiple_refunds_for_attempt', refundIds: ['r1', 'r2'] })
    expect(evaluateAttemptEvidence(list({ id: 'rfnd_dash', status: 'failed', notes: {} }), A, known))
      .toEqual({ kind: 'contradictory', why: 'unrecorded_refund_on_payment', refundIds: ['rfnd_dash'] })
    expect(evaluateAttemptEvidence(list({ id: 'rfnd_other', status: 'processed', notes: { attemptId: 'att_someoneelse0000' } }), A, known))
      .toMatchObject({ kind: 'contradictory', why: 'unrecorded_refund_on_payment' })
  })
  it('inconclusive: anything that is not a complete, well-formed list', () => {
    for (const bad of [null, undefined, {}, { items: 'x' }, 'error']) expect(evaluateAttemptEvidence(bad, A, known)).toEqual({ kind: 'inconclusive', why: 'lookup_malformed' })
    expect(evaluateAttemptEvidence(list({ id: 'r', amount: 1 }), A, known)).toEqual({ kind: 'inconclusive', why: 'refund_entry_malformed' })
    expect(evaluateAttemptEvidence(list(null), A, known)).toEqual({ kind: 'inconclusive', why: 'refund_entry_malformed' })
    expect(evaluateAttemptEvidence(list({ status: 'processed' }), A, known)).toEqual({ kind: 'inconclusive', why: 'refund_entry_malformed' })
  })
})
