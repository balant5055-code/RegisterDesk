// RD-FIN-02 · ONE capacity definition: total = the ENFORCED capacity (deriveStoredEventCapacity),
// used = confirmed registrations (registrationCounters.totalCount), remaining = max(0, total − used).
import { describe, it, expect } from 'vitest'
import { resolveEventCapacitySummary, deriveStoredEventCapacity } from '@/lib/registrations/capacity'

describe('resolveEventCapacitySummary', () => {
  it('a numeric totalCapacity is the total — the draft and licence never are', () => {
    const s = resolveEventCapacitySummary({ eventDoc: { totalCapacity: 500 }, counter: { totalCount: 10 }, draftIntent: 999 })
    expect(s).toEqual({ total: 500, used: 10, remaining: 490, overBy: 0, fillPct: 2, source: 'event' })
  })
  it('agrees with the enforcement derivation for legacy docs (capacityPlan / free default)', () => {
    for (const ev of [{ capacityPlan: 'pack_1000' }, { pricing: { eventType: 'free' } }, { totalCapacity: 0 }]) {
      expect(resolveEventCapacitySummary({ eventDoc: ev, counter: null }).total).toBe(deriveStoredEventCapacity(ev))
    }
  })
  it('uncapped event: bounded by Σ LIVE pass quantities when every pass is capped, else unlimited', () => {
    const capped = { totalCapacity: null, pricing: { passes: [{ quantity: 200 }, { quantity: 400 }] } }
    expect(resolveEventCapacitySummary({ eventDoc: capped, counter: null })).toMatchObject({ total: 600, source: 'passes' })
    const open = { totalCapacity: null, pricing: { passes: [{ quantity: 200 }, { unlimited: true }] } }
    expect(resolveEventCapacitySummary({ eventDoc: open, counter: { totalCount: 5 } }))
      .toEqual({ total: null, used: 5, remaining: null, overBy: 0, fillPct: null, source: 'unlimited' })
  })
  it('no live doc ⇒ the draft intent (positive integer only); otherwise unknown', () => {
    expect(resolveEventCapacitySummary({ eventDoc: null, counter: null, draftIntent: 300 })).toMatchObject({ total: 300, source: 'draft' })
    for (const bad of [undefined, 0, -1, 2.5, '300']) {
      expect(resolveEventCapacitySummary({ eventDoc: null, counter: null, draftIntent: bad })).toMatchObject({ total: null, source: 'unknown' })
    }
  })
  it('oversell is flagged, never hidden: remaining floors at 0, overBy and fillPct > 100 report it', () => {
    expect(resolveEventCapacitySummary({ eventDoc: { totalCapacity: 550 }, counter: { totalCount: 560 } }))
      .toEqual({ total: 550, used: 560, remaining: 0, overBy: 10, fillPct: 102, source: 'event' })
  })
  it('an UNAVAILABLE counter is unknown, never 0 used', () => {
    expect(resolveEventCapacitySummary({ eventDoc: { totalCapacity: 100 }, counter: null, counterUnavailable: true }))
      .toMatchObject({ total: 100, used: null, remaining: null, fillPct: null })
  })
})
