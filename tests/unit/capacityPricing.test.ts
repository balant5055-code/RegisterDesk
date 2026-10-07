// RD-CAPACITY-01 — the capacity pricing engine.
//
// ═══ WHAT THESE TESTS ARE FOR ════════════════════════════════════════════════
// This is the arithmetic that decides what an organizer is charged. Every other layer —
// the Razorpay order, the ledger, the receipt, the admin console — reports whatever this
// module returns, so an error here is not a display bug, it is a wrong charge that
// reconciles perfectly against itself.
//
// So the assertions are on EXACT PAISE, never on rupees and never on a tolerance. The
// worked examples from the commercial model (₹708 at 500, ₹596.49 at 437, ₹885 for
// 500→1,000) are pinned literally: if the model is ever restated, these fail, which is
// the point.
//
// Determinism matters as much as correctness. These functions take no clock, no Firestore
// and no config — the terms are an argument — so a test that passes here cannot pass for
// the wrong reason (a cached config, a default that happened to be 100).

import { describe, it, expect } from 'vitest'
import {
  applyPercentPaise, chargeableFor, validateCapacity,
  calculateActivationQuote, calculateCapacityIncreaseQuote, calculateCapacityDecreaseQuote,
  quoteCapacityChange, formatPaise,
} from '@/lib/licensing/capacityPricing'
import {
  DEFAULT_COMMERCIAL_TERMS, validateCommercialTerms, isCommercialTerms,
  normalizeCommercialTerms, COMMERCIAL_TERM_KEYS, type CommercialTerms,
} from '@/lib/licensing/capacityCommercial'
import { BUSINESS_CONFIG_DEFAULTS, validateBusinessConfig } from '@/lib/config/businessConfig'

/** The approved model, stated explicitly so no test depends on a default being 100. */
const T: CommercialTerms = {
  freeRegistrationCapacity:      100,
  activationRatePaise:           150,
  gstRatePercent:                18,
  attendeeTransactionFeePercent: 2.5,
  capacityDecreaseFeePercent:    1,
  maximumEventCapacity:          200_000,
}

const activation = (capacity: unknown, terms = T) => calculateActivationQuote({ capacity, terms })
const increase   = (currentCapacity: unknown, newCapacity: unknown, terms = T) =>
  calculateCapacityIncreaseQuote({ currentCapacity, newCapacity, terms })
const decrease   = (currentCapacity: unknown, newCapacity: unknown, terms = T) =>
  calculateCapacityDecreaseQuote({ currentCapacity, newCapacity, terms })

/** Unwrap a quote, failing loudly (with the reason) when the call was rejected. */
function ok(r: ReturnType<typeof activation>) {
  if (!r.ok) throw new Error(`expected a quote, got ${r.code}: ${r.message}`)
  return r.quote
}

// ═══ 1 · the commercial terms are configuration, never constants ══════════════

describe('commercial terms', () => {
  it('ship the approved defaults — 100 free · ₹1.50 · 18% · 2.5% · 1% · 200,000', () => {
    expect(DEFAULT_COMMERCIAL_TERMS).toEqual({
      freeRegistrationCapacity:      100,
      activationRatePaise:           150,
      gstRatePercent:                18,
      attendeeTransactionFeePercent: 2.5,
      capacityDecreaseFeePercent:    1,
      maximumEventCapacity:          200_000,
    })
  })

  it('are reachable through the Business Configuration section, so Super Admin can change them', () => {
    expect(BUSINESS_CONFIG_DEFAULTS.licensing.commercial).toEqual(DEFAULT_COMMERCIAL_TERMS)
    // …and the section still validates as a whole with them present.
    expect(validateBusinessConfig({ licensing: BUSINESS_CONFIG_DEFAULTS.licensing }).valid).toBe(true)
  })

  it('reject a config that would produce a NaN or negative charge', () => {
    const bad: Record<string, unknown>[] = [
      { ...T, activationRatePaise: Number.NaN },
      { ...T, activationRatePaise: Number.POSITIVE_INFINITY },
      { ...T, activationRatePaise: -150 },
      { ...T, activationRatePaise: 1.5 },            // paise must be whole
      { ...T, gstRatePercent: 101 },
      { ...T, gstRatePercent: -1 },
      { ...T, freeRegistrationCapacity: 10.5 },
      { ...T, maximumEventCapacity: 0 },
      { ...T, maximumEventCapacity: 50 },            // below the free allowance
      { ...T, capacityDecreaseFeePercent: '1' },
    ]
    for (const b of bad) {
      expect(validateCommercialTerms(b), JSON.stringify(b)).not.toHaveLength(0)
      expect(isCommercialTerms(b)).toBe(false)
    }
    expect(validateCommercialTerms(T)).toHaveLength(0)
    expect(validateCommercialTerms(null)).toEqual(['commercial must be an object'])
  })

  it('normalize a PARTIAL override field-by-field, keeping the global value for the rest', () => {
    const globals: CommercialTerms = { ...T, activationRatePaise: 200 }
    const merged  = normalizeCommercialTerms({ freeRegistrationCapacity: 500 }, globals)
    expect(merged.freeRegistrationCapacity).toBe(500)
    expect(merged.activationRatePaise).toBe(200)     // inherited, not reset to the code default
  })

  it('discard only the CORRUPT field of an override, never the whole event pricing', () => {
    const merged = normalizeCommercialTerms(
      { activationRatePaise: Number.NaN, gstRatePercent: 5 }, T)
    expect(merged.activationRatePaise).toBe(150)     // corrupt → global
    expect(merged.gstRatePercent).toBe(5)            // valid → applied
    expect(isCommercialTerms(merged)).toBe(true)
  })

  it('lists every term key, so an admin form cannot silently omit one', () => {
    expect([...COMMERCIAL_TERM_KEYS].sort()).toEqual(Object.keys(T).sort())
  })
})

// ═══ 2 · one rounding policy ══════════════════════════════════════════════════

describe('the chargeable curve', () => {
  it('is capacity minus the free allowance, floored at zero — the one curve both deltas use', () => {
    expect(chargeableFor(1, T)).toBe(0)
    expect(chargeableFor(100, T)).toBe(0)
    expect(chargeableFor(101, T)).toBe(1)
    expect(chargeableFor(437, T)).toBe(337)
    expect(chargeableFor(200_000, T)).toBe(199_900)
    // …and it tracks a configured allowance rather than a hardcoded 100.
    expect(chargeableFor(437, { ...T, freeRegistrationCapacity: 400 })).toBe(37)
    expect(chargeableFor(437, { ...T, freeRegistrationCapacity: 0 })).toBe(437)
  })

  it('is monotonic, so more capacity never costs less', () => {
    let prev = -1
    for (let c = 1; c <= 1_000; c++) {
      const v = chargeableFor(c, T)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('rounding', () => {
  it('is half-up on integer paise — the same rule lib/fees/engine.ts uses for GST', () => {
    expect(applyPercentPaise(60_000, 18)).toBe(10_800)
    expect(applyPercentPaise(50_550, 18)).toBe(9_099)
    // 1 paise × 50% = 0.5 → 1 (half-up), not 0 and not 0.5
    expect(applyPercentPaise(1, 50)).toBe(1)
    expect(applyPercentPaise(3, 50)).toBe(2)         // 1.5 → 2
    expect(applyPercentPaise(0, 18)).toBe(0)
  })

  it('never emits a fractional paise, for any capacity in range', () => {
    for (const c of [1, 99, 100, 101, 437, 500, 999, 1_000, 2_501, 123_457, 200_000]) {
      const q = ok(activation(c))
      for (const v of [q.basePaise, q.gstPaise, q.totalPaise]) {
        expect(Number.isInteger(v), `capacity ${c} produced ${v}`).toBe(true)
      }
    }
  })

  it('works in paise so the rupee float trap cannot reach an amount', () => {
    // The trap, on this model's OWN numbers. Capacity 109 bills 9 slots = ₹13.50, and
    // 18% of ₹13.50 in rupees is 2.4299999999999997 — a value that is not a whole number
    // of paise. Sent to Razorpay or written to a ledger it is a reconciliation break, and
    // it is exactly why `Number(rupees * percent)` is banned from this module.
    expect(13.5 * 0.18).not.toBe(2.43)
    expect(Number.isInteger(13.5 * 0.18 * 100)).toBe(false)

    // The paise path is exact: an integer rate × an integer capacity, then one rounding.
    const small = ok(activation(109))
    expect(small.basePaise).toBe(1_350)
    expect(small.gstPaise).toBe(243)
    expect(small.totalPaise).toBe(1_593)

    const q = ok(activation(437))
    expect(q.basePaise).toBe(50_550)
    expect(q.gstPaise).toBe(9_099)
  })
})

// ═══ 3 · activation — the mandated capacity cases ═════════════════════════════

describe('activation quotes', () => {
  it('capacity exactly at the free allowance is free and creates NO payment', () => {
    const q = ok(activation(100))
    expect(q.chargeableCapacity).toBe(0)
    expect(q.basePaise).toBe(0)
    expect(q.gstPaise).toBe(0)
    expect(q.totalPaise).toBe(0)
    expect(q.paymentRequired).toBe(false)
  })

  it('capacity BELOW the free allowance is also free', () => {
    for (const c of [1, 50, 99]) {
      const q = ok(activation(c))
      expect(q.totalPaise).toBe(0)
      expect(q.paymentRequired).toBe(false)
      expect(q.capacity).toBe(c)                     // …and is not inflated to 100
    }
  })

  it('capacity 101 charges exactly one slot plus GST', () => {
    const q = ok(activation(101))
    expect(q.chargeableCapacity).toBe(1)
    expect(q.basePaise).toBe(150)                    // ₹1.50
    expect(q.gstPaise).toBe(27)                      // 18% of 150 = 27
    expect(q.totalPaise).toBe(177)                   // ₹1.77
    expect(q.paymentRequired).toBe(true)
  })

  it('capacity 437 → ₹505.50 + ₹90.99 GST = ₹596.49 (the arbitrary-capacity example)', () => {
    const q = ok(activation(437))
    expect(q.capacity).toBe(437)
    expect(q.chargeableCapacity).toBe(337)
    expect(q.basePaise).toBe(50_550)
    expect(q.gstPaise).toBe(9_099)
    expect(q.totalPaise).toBe(59_649)
    expect(formatPaise(q.basePaise)).toBe('₹505.50')
    expect(formatPaise(q.gstPaise)).toBe('₹90.99')
    expect(formatPaise(q.totalPaise)).toBe('₹596.49')
  })

  it('capacity 500 → ₹600 + ₹108 GST = ₹708 (the headline example)', () => {
    const q = ok(activation(500))
    expect(q.chargeableCapacity).toBe(400)
    expect(q.basePaise).toBe(60_000)
    expect(q.gstPaise).toBe(10_800)
    expect(q.totalPaise).toBe(70_800)
    expect(formatPaise(q.totalPaise)).toBe('₹708')
  })

  it('capacity 200,000 — the maximum — is quotable', () => {
    const q = ok(activation(200_000))
    expect(q.chargeableCapacity).toBe(199_900)
    expect(q.basePaise).toBe(29_985_000)             // ₹299,850
    expect(q.gstPaise).toBe(5_397_300)               // ₹53,973
    expect(q.totalPaise).toBe(35_382_300)            // ₹353,823
  })

  it('capacity above the maximum is REJECTED, not clamped', () => {
    const r = activation(200_001)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('CAPACITY_ABOVE_MAXIMUM')
    // Indian digit grouping, matching formatPaise — the message names the real ceiling
    // rather than a generic refusal, so the organizer knows what to enter instead.
    expect(r.message).toContain('2,00,000')
  })

  it('carries the terms it used, so the charge can be re-derived from the record alone', () => {
    const q = ok(activation(437))
    expect(q.terms).toEqual(T)
    expect(q.freeCapacity).toBe(100)
    expect(q.activationRatePaise).toBe(150)
    expect(q.gstRatePercent).toBe(18)
    // base + gst always reconciles to total, and base re-derives from the inputs
    expect(q.chargeableCapacity * q.activationRatePaise).toBe(q.basePaise)
    expect(q.basePaise + q.gstPaise).toBe(q.totalPaise)
  })

  it('never quantizes to a bucket — 437 stays 437, 501 stays 501', () => {
    for (const c of [101, 201, 437, 501, 999, 1_001, 2_501, 5_001]) {
      expect(ok(activation(c)).capacity).toBe(c)
    }
  })
})

// ═══ 4 · invalid capacity is refused, never coerced ═══════════════════════════

describe('capacity validation', () => {
  it('rejects NaN, Infinity, negatives, zero, decimals and non-numbers', () => {
    const cases: [unknown, string][] = [
      [Number.NaN, 'INVALID_CAPACITY'],
      [Number.POSITIVE_INFINITY, 'INVALID_CAPACITY'],
      [Number.NEGATIVE_INFINITY, 'INVALID_CAPACITY'],
      [437.5, 'INVALID_CAPACITY'],
      ['500', 'INVALID_CAPACITY'],                   // a numeric STRING is not a number
      ['437abc', 'INVALID_CAPACITY'],
      [true, 'INVALID_CAPACITY'],                    // Number(true) === 1 — never coerced
      [null, 'INVALID_CAPACITY'],
      [undefined, 'INVALID_CAPACITY'],
      [{}, 'INVALID_CAPACITY'],
      [[500], 'INVALID_CAPACITY'],
      [0, 'CAPACITY_BELOW_MINIMUM'],
      [-1, 'CAPACITY_BELOW_MINIMUM'],
      [-500, 'CAPACITY_BELOW_MINIMUM'],
      [Number.MAX_SAFE_INTEGER, 'CAPACITY_ABOVE_MAXIMUM'],
      [1e21, 'CAPACITY_ABOVE_MAXIMUM'],
    ]
    for (const [value, code] of cases) {
      const v = validateCapacity(value, T)
      expect(v.ok, `${String(value)} was accepted`).toBe(false)
      if (!v.ok) expect(v.code, String(value)).toBe(code)
      // …and the quote function refuses it too, rather than emitting a NaN amount.
      const q = activation(value)
      expect(q.ok, `activation accepted ${String(value)}`).toBe(false)
    }
  })

  it('refuses to quote against invalid TERMS rather than charging NaN', () => {
    const r = activation(500, { ...T, activationRatePaise: Number.NaN })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.code).toBe('INVALID_TERMS')
  })
})

// ═══ 5 · increase — only the additional capacity is billed ════════════════════

describe('capacity increase quotes', () => {
  it('100 → 500 bills 400 slots = ₹708, the same as activating at 500', () => {
    const q = ok(increase(100, 500))
    expect(q.kind).toBe('increase')
    expect(q.previousCapacity).toBe(100)
    expect(q.capacity).toBe(500)
    expect(q.chargeableCapacity).toBe(400)
    expect(q.totalPaise).toBe(70_800)
    expect(q.totalPaise).toBe(ok(activation(500)).totalPaise)
  })

  it('500 → 1,000 bills 500 slots → ₹750 + ₹135 GST = ₹885', () => {
    const q = ok(increase(500, 1_000))
    expect(q.chargeableCapacity).toBe(500)
    expect(q.basePaise).toBe(75_000)
    expect(q.gstPaise).toBe(13_500)
    expect(q.totalPaise).toBe(88_500)
    expect(formatPaise(q.totalPaise)).toBe('₹885')
  })

  it('is PATH-INDEPENDENT: 100→437 then 437→1,000 costs the same as 100→1,000', () => {
    const oneStep = ok(increase(100, 1_000)).totalPaise
    const stepA   = ok(increase(100, 437)).totalPaise
    const stepB   = ok(increase(437, 1_000)).totalPaise
    // Base amounts sum exactly; GST is rounded per charge, so compare the bases and
    // allow the two roundings to differ from one by at most a paise each.
    expect(ok(increase(100, 437)).basePaise + ok(increase(437, 1_000)).basePaise)
      .toBe(ok(increase(100, 1_000)).basePaise)
    expect(Math.abs(stepA + stepB - oneStep)).toBeLessThanOrEqual(1)
  })

  it('never bills capacity that was inside the free allowance', () => {
    // An event sitting at 50 (free) raised to 500 pays for 400 slots, not 450 — the
    // first 100 are free once, and they were never bought.
    const q = ok(increase(50, 500))
    expect(q.chargeableCapacity).toBe(400)
    expect(q.totalPaise).toBe(70_800)
  })

  it('an increase that stays inside the free allowance costs nothing', () => {
    const q = ok(increase(50, 100))
    expect(q.chargeableCapacity).toBe(0)
    expect(q.totalPaise).toBe(0)
    expect(q.paymentRequired).toBe(false)
  })

  it('refuses an equal or lower capacity — a decrease is NOT a zero-rupee increase', () => {
    for (const [cur, next] of [[500, 500], [500, 400], [1_000, 1]] as const) {
      const r = increase(cur, next)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_AN_INCREASE')
    }
  })

  it('validates BOTH capacities, and says which one was wrong', () => {
    const bad = increase(Number.NaN, 500)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('INVALID_CURRENT_CAPACITY')
    const over = increase(500, 200_001)
    expect(over.ok).toBe(false)
    if (!over.ok) expect(over.code).toBe('CAPACITY_ABOVE_MAXIMUM')
  })
})

// ═══ 6 · decrease — a charge, never a refund ══════════════════════════════════

describe('capacity decrease quotes', () => {
  it('1,000 → 500 charges 1% of the removed capacity value, plus GST', () => {
    const q = ok(decrease(1_000, 500))
    expect(q.kind).toBe('decrease')
    expect(q.chargeableCapacity).toBe(500)                  // slots removed
    expect(q.removedCapacityValuePaise).toBe(75_000)        // 500 × ₹1.50 = ₹750
    expect(q.decreaseFeePercent).toBe(1)
    expect(q.basePaise).toBe(750)                           // 1% of ₹750 = ₹7.50
    expect(q.gstPaise).toBe(135)                            // 18% of ₹7.50 = ₹1.35
    expect(q.totalPaise).toBe(885)                          // ₹8.85
    expect(formatPaise(q.totalPaise)).toBe('₹8.85')
  })

  it('applies GST from the SAME authoritative terms as every other charge', () => {
    const q = ok(decrease(1_000, 500, { ...T, gstRatePercent: 5 }))
    expect(q.gstRatePercent).toBe(5)
    expect(q.gstPaise).toBe(38)                             // round(750 × 5 / 100) = 37.5 → 38
    expect(q.totalPaise).toBe(788)
  })

  it('honours a configured decrease percentage, and 0% means no charge', () => {
    expect(ok(decrease(1_000, 500, { ...T, capacityDecreaseFeePercent: 2 })).basePaise).toBe(1_500)
    const freeDecrease = ok(decrease(1_000, 500, { ...T, capacityDecreaseFeePercent: 0 }))
    expect(freeDecrease.totalPaise).toBe(0)
    expect(freeDecrease.paymentRequired).toBe(false)
  })

  it('does not charge for giving back capacity that was free', () => {
    const q = ok(decrease(100, 50))
    expect(q.chargeableCapacity).toBe(0)
    expect(q.totalPaise).toBe(0)
  })

  it('computes NO refund and reports no negative amount', () => {
    const q = ok(decrease(5_000, 200))
    expect(q.basePaise).toBeGreaterThan(0)
    expect(q.totalPaise).toBeGreaterThan(0)
    for (const v of [q.basePaise, q.gstPaise, q.totalPaise, q.removedCapacityValuePaise ?? 0]) {
      expect(v).toBeGreaterThanOrEqual(0)
    }
  })

  it('refuses an equal or higher capacity', () => {
    for (const [cur, next] of [[500, 500], [500, 600]] as const) {
      const r = decrease(cur, next)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('NOT_A_DECREASE')
    }
  })
})

// ═══ 7 · the dispatcher cannot mistake one operation for another ══════════════

describe('quoteCapacityChange', () => {
  it('routes by comparison, so no caller decides increase-vs-decrease twice', () => {
    expect(ok(quoteCapacityChange({ currentCapacity: 500, newCapacity: 1_000, terms: T })).kind).toBe('increase')
    expect(ok(quoteCapacityChange({ currentCapacity: 1_000, newCapacity: 500, terms: T })).kind).toBe('decrease')
  })

  it('treats an unchanged capacity as a free no-op, not an error and not a charge', () => {
    const q = ok(quoteCapacityChange({ currentCapacity: 437, newCapacity: 437, terms: T }))
    expect(q.kind).toBe('unchanged')
    expect(q.capacity).toBe(437)
    expect(q.previousCapacity).toBe(437)
    expect(q.totalPaise).toBe(0)
    expect(q.paymentRequired).toBe(false)
  })

  it('agrees exactly with the operation-specific functions', () => {
    for (const [cur, next] of [[100, 437], [500, 1_000], [1_000, 500], [2_500, 137]] as const) {
      const viaDispatch = ok(quoteCapacityChange({ currentCapacity: cur, newCapacity: next, terms: T }))
      const direct = next > cur ? ok(increase(cur, next)) : ok(decrease(cur, next))
      expect(viaDispatch).toEqual(direct)
    }
  })
})

// ═══ 8 · a configuration change reprices FUTURE quotes only ═══════════════════

describe('configuration', () => {
  it('a changed global rate changes new quotes', () => {
    const cheaper = ok(activation(500, { ...T, activationRatePaise: 100 }))
    expect(cheaper.basePaise).toBe(40_000)
    expect(cheaper.gstPaise).toBe(7_200)
    expect(cheaper.totalPaise).toBe(47_200)
  })

  it('a changed free allowance is respected — 100 is never assumed', () => {
    const q = ok(activation(500, { ...T, freeRegistrationCapacity: 200 }))
    expect(q.freeCapacity).toBe(200)
    expect(q.chargeableCapacity).toBe(300)
    expect(q.basePaise).toBe(45_000)
    // …and with a 500-free allowance, a 500-capacity event is free.
    expect(ok(activation(500, { ...T, freeRegistrationCapacity: 500 })).totalPaise).toBe(0)
  })

  it('a changed maximum moves the ceiling both ways', () => {
    expect(activation(300_000, { ...T, maximumEventCapacity: 500_000 }).ok).toBe(true)
    expect(activation(1_000, { ...T, maximumEventCapacity: 500 }).ok).toBe(false)
  })

  it('an event-specific override prices that event, and leaves the global terms alone', () => {
    const globals = { ...T }
    const perEvent = normalizeCommercialTerms({ activationRatePaise: 50 }, globals)
    expect(ok(activation(500, perEvent)).basePaise).toBe(20_000)
    expect(ok(activation(500, globals)).basePaise).toBe(60_000)   // untouched
  })

  it('a quote already produced is a VALUE — later term changes cannot mutate it', () => {
    const mutable: CommercialTerms = { ...T }
    const q = ok(activation(500, mutable))
    mutable.activationRatePaise = 9_999
    expect(q.terms.activationRatePaise).toBe(150)   // the snapshot was copied, not referenced
    expect(q.totalPaise).toBe(70_800)
  })
})

// ═══ 9 · display formatting ═══════════════════════════════════════════════════

describe('formatPaise', () => {
  it('renders whole rupees without a decimal and part-rupees with exactly two', () => {
    expect(formatPaise(0)).toBe('₹0')
    expect(formatPaise(150)).toBe('₹1.50')
    expect(formatPaise(27)).toBe('₹0.27')
    expect(formatPaise(5)).toBe('₹0.05')
    expect(formatPaise(70_800)).toBe('₹708')
    expect(formatPaise(59_649)).toBe('₹596.49')
    expect(formatPaise(35_382_300)).toBe('₹3,53,823')   // Indian digit grouping
  })
})
