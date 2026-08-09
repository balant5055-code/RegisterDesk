// RD-MC-REFUND-V2-P1 · FIFO attribution. Pure — no Firestore.
//
// The brief's worked example is the first test. Everything after it is a way FIFO could go
// wrong in a system where the money is real.

import { describe, it, expect } from 'vitest'
import {
  allocateFifo, refundDebitFor, totalRemaining, type CreditLot,
} from '@/features/media-credits/utils/creditLots'

const lot = (id: string, seq: number, remaining: number, kind: CreditLot['kind'] = 'purchase'): CreditLot =>
  ({ lotId: id, kind, seq, remaining })

describe("allocateFifo — the brief's worked example", () => {
  const lots = [lot('A', 1, 500), lot('B', 2, 200)]

  it('50 photos take from the oldest lot only', () => {
    const out = allocateFifo(lots, 50)
    expect(out.debits).toEqual([
      { lotId: 'A', kind: 'purchase', credits: 50, remainingAfter: 450 },
    ])
    expect(out.unattributed).toBe(0)
  })

  it('480 more drain A and spill into B', () => {
    // A is at 450 after the first upload.
    const out = allocateFifo([lot('A', 1, 450), lot('B', 2, 200)], 480)
    expect(out.debits).toEqual([
      { lotId: 'A', kind: 'purchase', credits: 450, remainingAfter: 0 },
      { lotId: 'B', kind: 'purchase', credits: 30,  remainingAfter: 170 },
    ])
  })
})

describe('oldest first, always', () => {
  it('orders by seq regardless of the order given', () => {
    const out = allocateFifo([lot('C', 3, 100), lot('A', 1, 100), lot('B', 2, 100)], 250)
    expect(out.debits.map(d => d.lotId)).toEqual(['A', 'B', 'C'])
  })

  it('never skips an older lot to reach a bigger one', () => {
    const out = allocateFifo([lot('old', 1, 5), lot('new', 2, 1_000)], 100)
    expect(out.debits[0]).toMatchObject({ lotId: 'old', credits: 5 })
    expect(out.debits[1]).toMatchObject({ lotId: 'new', credits: 95 })
  })

  it('mixes grants and purchases on ONE timeline', () => {
    // A grant that arrived first is spent first, exactly like a purchase.
    const out = allocateFifo([
      lot('G1', 1, 100, 'grant'), lot('P1', 2, 500), lot('P2', 3, 200),
    ], 550)
    expect(out.debits).toEqual([
      { lotId: 'G1', kind: 'grant',    credits: 100, remainingAfter: 0 },
      { lotId: 'P1', kind: 'purchase', credits: 450, remainingAfter: 50 },
    ])
  })

  it('breaks ties deterministically', () => {
    const a = allocateFifo([lot('b', 1, 10), lot('a', 1, 10)], 15)
    const b = allocateFifo([lot('a', 1, 10), lot('b', 1, 10)], 15)
    expect(a.debits).toEqual(b.debits)
    expect(a.debits[0].lotId).toBe('a')
  })
})

describe('never over-draws', () => {
  it('takes no more than a lot holds', () => {
    const out = allocateFifo([lot('A', 1, 30)], 100)
    expect(out.debits).toEqual([
      { lotId: 'A', kind: 'purchase', credits: 30, remainingAfter: 0 },
    ])
  })

  it('reports the shortfall rather than inventing credits', () => {
    // Lots and wallet disagree. This is the drift the feature exists to expose.
    const out = allocateFifo([lot('A', 1, 30)], 100)
    expect(out.unattributed).toBe(70)
  })

  it('with NO lots, everything is unattributed', () => {
    const out = allocateFifo([], 40)
    expect(out.debits).toEqual([])
    expect(out.unattributed).toBe(40)
  })
})

describe('drained and corrupt lots', () => {
  it('skips lots that are already empty', () => {
    const out = allocateFifo([lot('A', 1, 0), lot('B', 2, 50)], 20)
    expect(out.debits.map(d => d.lotId)).toEqual(['B'])
  })

  it('treats a corrupt remaining as zero, never NaN', () => {
    const out = allocateFifo([
      { lotId: 'bad', kind: 'purchase', seq: 1, remaining: 'x' as unknown as number },
      lot('B', 2, 50),
    ], 20)
    expect(out.debits.map(d => d.lotId)).toEqual(['B'])
    expect(Number.isFinite(out.unattributed)).toBe(true)
  })

  it('a negative remaining cannot create credits', () => {
    const out = allocateFifo([lot('A', 1, -100), lot('B', 2, 10)], 10)
    expect(out.debits).toEqual([
      { lotId: 'B', kind: 'purchase', credits: 10, remainingAfter: 0 },
    ])
  })
})

describe('zero and no-op cases', () => {
  it('consuming zero takes nothing', () => {
    const out = allocateFifo([lot('A', 1, 500)], 0)
    expect(out.debits).toEqual([])
    expect(out.unattributed).toBe(0)
  })

  it('a negative request takes nothing', () => {
    expect(allocateFifo([lot('A', 1, 500)], -50).debits).toEqual([])
  })
})

describe('totalRemaining — the invariant’s left side', () => {
  it('sums every lot', () => {
    expect(totalRemaining([lot('A', 1, 450), lot('B', 2, 170), lot('G', 0, 100, 'grant')])).toBe(720)
  })

  it('ignores corrupt values rather than returning NaN', () => {
    const t = totalRemaining([
      lot('A', 1, 100),
      { lotId: 'x', kind: 'grant', seq: 2, remaining: undefined as unknown as number },
    ])
    expect(t).toBe(100)
  })

  it('the allocation conserves credits — Σ debits + Σ after == Σ before', () => {
    const lots = [lot('A', 1, 500), lot('B', 2, 200), lot('G', 0, 100, 'grant')]
    const before = totalRemaining(lots)
    const out = allocateFifo(lots, 550)
    const taken = out.debits.reduce((n, d) => n + d.credits, 0)
    const untouched = lots
      .filter(l => !out.debits.some(d => d.lotId === l.lotId))
      .reduce((n, l) => n + l.remaining, 0)
    const after = out.debits.reduce((n, d) => n + d.remainingAfter, 0) + untouched
    expect(taken + after).toBe(before)
  })
})

describe('refundDebitFor', () => {
  it('drains the lot for a whole-purchase refund', () => {
    expect(refundDebitFor(lot('P1', 1, 500), 500)).toEqual({
      lotId: 'P1', kind: 'purchase', credits: 500, remainingAfter: 0,
    })
  })

  it('never takes more than the lot holds', () => {
    // A purchase partly spent then refunded: only what remains can be returned.
    expect(refundDebitFor(lot('P1', 1, 50), 500)).toEqual({
      lotId: 'P1', kind: 'purchase', credits: 50, remainingAfter: 0,
    })
  })

  it('is null when there is nothing to take', () => {
    expect(refundDebitFor(lot('P1', 1, 0), 500)).toBeNull()
    expect(refundDebitFor(null, 500)).toBeNull()
    expect(refundDebitFor(lot('P1', 1, 100), 0)).toBeNull()
  })
})
