// M1 — the PURE re-fit planner: which payout reservations survive a lower available balance (approved before
// pending, then oldest, greedy), and which go to review. Requests without a reservation are never touched.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const { planPayoutRefit } = await import('@/lib/settlements/payoutReview')
type R = Parameters<typeof planPayoutRefit>[0][number]
const r = (id: string, status: 'pending' | 'approved', amountPaise: number, requestedAtMs: number, extra: Partial<R> = {}): R =>
  ({ id, ref: {} as R['ref'], status, amountPaise, reserved: true, reviewOpen: false, requestedAtMs, ...extra })

describe('planPayoutRefit', () => {
  it('everything fits ⇒ nothing reviewed; kept = Σ reservations', () => {
    expect(planPayoutRefit([r('a', 'approved', 4_000, 1), r('b', 'pending', 1_000, 2)], 5_000)).toEqual({ keptPaise: 5_000, toReview: [] })
  })
  it('approved before pending, then oldest; greedy (a later smaller request still fits)', () => {
    const p = planPayoutRefit([r('c', 'pending', 1_000, 1), r('b', 'approved', 3_000, 3), r('a', 'approved', 4_000, 2)], 5_000)
    expect(p.keptPaise).toBe(5_000)                                                     // a (4,000) + c (1,000)
    expect(p.toReview.map(x => [x.id, x.keptAheadPaise])).toEqual([['b', 4_000]])
  })
  it('legacy requests (no reservation) and requests already under review are ignored', () => {
    const p = planPayoutRefit([r('legacy', 'approved', 9_000, 1, { reserved: false }), r('rev', 'approved', 9_000, 1, { reserved: false, reviewOpen: true }), r('x', 'approved', 2_000, 5)], 2_000)
    expect(p).toEqual({ keptPaise: 2_000, toReview: [] })
  })
  it('zero available ⇒ every reservation reviewed; a tie on time is broken by id (deterministic)', () => {
    const p = planPayoutRefit([r('b', 'approved', 1, 7), r('a', 'approved', 1, 7)], 0)
    expect(p.keptPaise).toBe(0)
    expect(p.toReview.map(x => x.id)).toEqual(['a', 'b'])
  })
})
