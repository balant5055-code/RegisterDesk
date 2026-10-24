// Phase 3 (Option C) — the pure split of a release between clawback debt and available (integer paise).

import { describe, it, expect } from 'vitest'
import { planClawbackRecovery } from '@/lib/clawbacks/recoveryPlan'

const debt = (id: string, outstandingPaise: number, createdAtMs: number) => ({ id, outstandingPaise, createdAtMs })

describe('planClawbackRecovery', () => {
  it('zero debt: the whole release is credited', () => {
    expect(planClawbackRecovery(50_000, [])).toEqual({ recoveredPaise: 0, creditedPaise: 50_000, takes: [] })
    expect(planClawbackRecovery(50_000, [debt('a', 0, 1)])).toEqual({ recoveredPaise: 0, creditedPaise: 50_000, takes: [] })
  })
  it('the original scenario: ₹600 debt, then releases of ₹500 and ₹800', () => {
    const first = planClawbackRecovery(50_000, [debt('c1', 60_000, 1)])
    expect(first).toEqual({ recoveredPaise: 50_000, creditedPaise: 0, takes: [{ id: 'c1', takePaise: 50_000, remainingPaise: 10_000 }] })
    const second = planClawbackRecovery(80_000, [debt('c1', 10_000, 1)])
    expect(second).toEqual({ recoveredPaise: 10_000, creditedPaise: 70_000, takes: [{ id: 'c1', takePaise: 10_000, remainingPaise: 0 }] })
  })
  it('oldest debt first (ties by id), partial recovery of the next', () => {
    const p = planClawbackRecovery(70_000, [debt('new', 40_000, 300), debt('old', 50_000, 100), debt('mid', 30_000, 200)])
    expect(p.takes).toEqual([
      { id: 'old', takePaise: 50_000, remainingPaise: 0 },
      { id: 'mid', takePaise: 20_000, remainingPaise: 10_000 },
    ])
    expect(p).toMatchObject({ recoveredPaise: 70_000, creditedPaise: 0 })
    expect(planClawbackRecovery(10, [debt('b', 5, 1), debt('a', 5, 1)]).takes.map(t => t.id)).toEqual(['a', 'b'])
  })
  it('debt larger than the release: the whole release pays debt, the rest stays outstanding', () => {
    expect(planClawbackRecovery(1_000, [debt('c', 9_999, 1)])).toEqual({ recoveredPaise: 1_000, creditedPaise: 0, takes: [{ id: 'c', takePaise: 1_000, remainingPaise: 8_999 }] })
  })
  it('a zero release recovers nothing', () => {
    expect(planClawbackRecovery(0, [debt('c', 100, 1)])).toEqual({ recoveredPaise: 0, creditedPaise: 0, takes: [] })
  })
  it('fails closed on values that cannot be accounted', () => {
    expect(() => planClawbackRecovery(10.5, [])).toThrow(/^CLAWBACK_INVALID/)
    expect(() => planClawbackRecovery(-1, [])).toThrow(/^CLAWBACK_INVALID/)
    expect(() => planClawbackRecovery(100, [debt('x', 1.5, 1)])).toThrow(/^CLAWBACK_INVALID:x/)
    expect(() => planClawbackRecovery(100, [debt('x', -5, 1)])).toThrow(/^CLAWBACK_INVALID:x/)
    expect(() => planClawbackRecovery(100, [{ id: 'x', outstandingPaise: undefined as unknown as number, createdAtMs: 1 }])).toThrow(/^CLAWBACK_INVALID:x/)
  })
  it('invariant: recovered + credited = release; recovered ≤ total debt', () => {
    for (const [rel, debts] of [[0, [7]], [5, [3, 3]], [12_345, [10_000, 2_000, 999]], [1, []]] as Array<[number, number[]]>) {
      const p = planClawbackRecovery(rel, debts.map((o, i) => debt(`d${i}`, o, i)))
      expect(p.recoveredPaise + p.creditedPaise).toBe(rel)
      expect(p.recoveredPaise).toBeLessThanOrEqual(debts.reduce((s, x) => s + x, 0))
      expect(p.takes.reduce((s, t) => s + t.takePaise, 0)).toBe(p.recoveredPaise)
    }
  })
})
