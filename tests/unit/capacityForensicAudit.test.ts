// RD-CAPACITY-02 — forensic verification of the money, against the REAL functions.
//
// ═══ WHY THIS FILE EXISTS SEPARATELY FROM capacityPricing.test.ts ════════════
// That suite was written alongside the implementation, so it proves the code does what its
// author intended. This one asks a different question: does the code do what the BUSINESS
// RULES say, for the specific figures the business stated?
//
// So every expected value below is transcribed from the commercial model, not from the
// implementation — and the decrease cases are computed from first principles and asserted
// exactly, because the decrease rule is the one place the implementation had to resolve an
// ambiguity in the stated rules. Section 3 documents precisely what it resolved it to.

import { describe, it, expect } from 'vitest'
import {
  calculateActivationQuote, calculateCapacityIncreaseQuote, calculateCapacityDecreaseQuote,
  chargeableFor,
} from '@/lib/licensing/capacityPricing'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'

const T = DEFAULT_COMMERCIAL_TERMS
const rupees = (paise: number) => paise / 100

function quote(capacity: number, terms: CommercialTerms = T) {
  const r = calculateActivationQuote({ capacity, terms })
  if (!r.ok) throw new Error(`rejected ${capacity}: ${r.code}`)
  return r.quote
}

// ═══ 1 · ACTIVATION — the figures the business stated ═════════════════════════

describe('activation, against the stated commercial model', () => {
  // Transcribed from the business rules, in RUPEES, then compared against paise.
  const CASES: { capacity: number; chargeable: number; base: number; gst: number; total: number }[] = [
    { capacity: 100,     chargeable: 0,       base: 0,        gst: 0,       total: 0        },
    { capacity: 101,     chargeable: 1,       base: 1.5,      gst: 0.27,    total: 1.77     },
    { capacity: 200,     chargeable: 100,     base: 150,      gst: 27,      total: 177      },
    { capacity: 437,     chargeable: 337,     base: 505.5,    gst: 90.99,   total: 596.49   },
    { capacity: 500,     chargeable: 400,     base: 600,      gst: 108,     total: 708      },
    { capacity: 1_000,   chargeable: 900,     base: 1_350,    gst: 243,     total: 1_593    },
    { capacity: 200_000, chargeable: 199_900, base: 299_850,  gst: 53_973,  total: 353_823  },
  ]

  for (const c of CASES) {
    it(`capacity ${c.capacity.toLocaleString('en-IN')} → ₹${c.total.toLocaleString('en-IN')}`, () => {
      const q = quote(c.capacity)
      expect(q.chargeableCapacity).toBe(c.chargeable)
      expect(rupees(q.basePaise)).toBe(c.base)
      expect(rupees(q.gstPaise)).toBe(c.gst)
      expect(rupees(q.totalPaise)).toBe(c.total)
      // And every stored amount is a whole number of paise.
      for (const v of [q.basePaise, q.gstPaise, q.totalPaise]) expect(Number.isInteger(v)).toBe(true)
      // total is exactly base + GST, with no third component.
      expect(q.basePaise + q.gstPaise).toBe(q.totalPaise)
      // The capacity is never quantised.
      expect(q.capacity).toBe(c.capacity)
    })
  }

  it('capacity 200,001 is REJECTED server-side, not clamped', () => {
    const r = calculateActivationQuote({ capacity: 200_001, terms: T })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CAPACITY_ABOVE_MAXIMUM')
  })

  it('the free tier boundary is the CONFIGURED value, not a hardcoded 100', () => {
    // Free at 100 and chargeable at 101 under the default; both move with configuration.
    expect(quote(100).paymentRequired).toBe(false)
    expect(quote(101).paymentRequired).toBe(true)
    const wider: CommercialTerms = { ...T, freeRegistrationCapacity: 250 }
    expect(quote(250, wider).paymentRequired).toBe(false)
    expect(quote(251, wider).paymentRequired).toBe(true)
  })
})

// ═══ 2 · INCREASE — only the additional capacity ══════════════════════════════

describe('increase, against the stated commercial model', () => {
  const inc = (cur: number, next: number, terms: CommercialTerms = T) => {
    const r = calculateCapacityIncreaseQuote({ currentCapacity: cur, newCapacity: next, terms })
    if (!r.ok) throw new Error(`rejected ${cur}→${next}: ${r.code}`)
    return r.quote
  }

  it('100 → 500 charges 400, not 500', () => {
    const q = inc(100, 500)
    expect(q.chargeableCapacity).toBe(400)
    expect(rupees(q.basePaise)).toBe(600)
    expect(rupees(q.gstPaise)).toBe(108)
    expect(rupees(q.totalPaise)).toBe(708)
  })

  it('500 → 1,000 charges 500, not 1,000', () => {
    const q = inc(500, 1_000)
    expect(q.chargeableCapacity).toBe(500)
    expect(rupees(q.basePaise)).toBe(750)
    expect(rupees(q.gstPaise)).toBe(135)
    expect(rupees(q.totalPaise)).toBe(885)
  })

  it('reaching a capacity costs the same however many steps it took', () => {
    // The property that makes the ledger explicable: no organizer pays more for arriving at
    // 2,000 gradually than for buying it outright.
    const direct = quote(2_000).basePaise
    const stepped = inc(100, 437).basePaise + inc(437, 900).basePaise + inc(900, 2_000).basePaise
    // The first 100 are free in both readings, so the stepped path starts from the free tier.
    expect(stepped).toBe(direct)
  })

  it('an increase is never priced as a decrease, or vice versa', () => {
    expect(calculateCapacityIncreaseQuote({ currentCapacity: 500, newCapacity: 400, terms: T }).ok).toBe(false)
    expect(calculateCapacityDecreaseQuote({ currentCapacity: 400, newCapacity: 500, terms: T }).ok).toBe(false)
  })
})

// ═══ 3 · DECREASE — the exact rule, documented ═══════════════════════════════
//
// THE IMPLEMENTED RULE, stated precisely:
//
//   removedChargeable = chargeableFor(current) − chargeableFor(new)
//                     = max(0, current − free) − max(0, new − free)
//   value             = removedChargeable × activationRatePaise
//   base              = round(value × capacityDecreaseFeePercent / 100)
//   gst               = round(base × gstRatePercent / 100)
//   total             = base + gst
//
// In words: the charge is a percentage of the value of the PAID capacity handed back.
// Capacity inside the free allowance is never charged for, because it was never bought.
//
// This differs from a literal `current − new` ONLY when the new capacity falls BELOW the free
// allowance. Cases C and E below are exactly that divergence, and they are asserted here so
// the behaviour is pinned and visible rather than incidental.

describe('decrease, with the divergence pinned', () => {
  const dec = (cur: number, next: number, terms: CommercialTerms = T) => {
    const r = calculateCapacityDecreaseQuote({ currentCapacity: cur, newCapacity: next, terms })
    if (!r.ok) throw new Error(`rejected ${cur}→${next}: ${r.code}`)
    return r.quote
  }

  const CASES = [
    // label, current, new, removedChargeable, value ₹, base ₹, gst ₹, total ₹
    ['A', 500,   400, 100, 150,   1.5,  0.27, 1.77 ],
    ['B', 500,   100, 400, 600,   6,    1.08, 7.08 ],
    ['C', 500,   50,  400, 600,   6,    1.08, 7.08 ],   // identical to B — see the note above
    ['D', 1_000, 100, 900, 1_350, 13.5, 2.43, 15.93],
    ['E', 1_000, 50,  900, 1_350, 13.5, 2.43, 15.93],   // identical to D
  ] as const

  for (const [label, cur, next, removed, value, base, gst, total] of CASES) {
    it(`${label} · ${cur.toLocaleString('en-IN')} → ${next} removes ${removed.toLocaleString('en-IN')} paid slots → ₹${total}`, () => {
      const q = dec(cur, next)
      expect(q.chargeableCapacity).toBe(removed)
      expect(rupees(q.removedCapacityValuePaise ?? -1)).toBe(value)
      expect(q.decreaseFeePercent).toBe(1)
      expect(rupees(q.basePaise)).toBe(base)
      expect(rupees(q.gstPaise)).toBe(gst)
      expect(rupees(q.totalPaise)).toBe(total)
      expect(q.basePaise + q.gstPaise).toBe(q.totalPaise)
      for (const v of [q.basePaise, q.gstPaise, q.totalPaise]) expect(Number.isInteger(v)).toBe(true)
    })
  }

  it('C costs the same as B, and E the same as D — free capacity is never charged for', () => {
    // The divergence from a literal `current − new`, asserted explicitly so it cannot change
    // silently. A literal reading would charge ₹7.97 for C and ₹16.82 for E.
    expect(dec(500, 50).totalPaise).toBe(dec(500, 100).totalPaise)
    expect(dec(1_000, 50).totalPaise).toBe(dec(1_000, 100).totalPaise)
  })

  it('giving back only free capacity costs nothing', () => {
    const q = dec(100, 50)
    expect(q.chargeableCapacity).toBe(0)
    expect(q.totalPaise).toBe(0)
    expect(q.paymentRequired).toBe(false)
  })

  it('is never a credit — every decrease amount is >= 0', () => {
    for (const [, cur, next] of CASES) {
      const q = dec(cur, next)
      for (const v of [q.basePaise, q.gstPaise, q.totalPaise, q.removedCapacityValuePaise ?? 0]) {
        expect(v).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('tracks the CONFIGURED decrease percentage and GST rate', () => {
    expect(rupees(dec(1_000, 100, { ...T, capacityDecreaseFeePercent: 2 }).basePaise)).toBe(27)
    expect(dec(1_000, 100, { ...T, capacityDecreaseFeePercent: 0 }).totalPaise).toBe(0)
    expect(rupees(dec(1_000, 100, { ...T, gstRatePercent: 0 }).totalPaise)).toBe(13.5)
  })

  it('the decrease value re-derives from the curve, so the rule is auditable', () => {
    const q = dec(1_000, 100)
    expect(chargeableFor(1_000, T) - chargeableFor(100, T)).toBe(q.chargeableCapacity)
    expect(q.chargeableCapacity * q.activationRatePaise).toBe(q.removedCapacityValuePaise)
  })
})

// ═══ 4 · no floating-point money anywhere in the results ═════════════════════

describe('integer paise, exhaustively', () => {
  it('holds across a wide sweep of capacities and rates', () => {
    const rates = [1, 7, 150, 199, 1_000]
    const gsts  = [0, 5, 12, 18, 28]
    for (const activationRatePaise of rates) {
      for (const gstRatePercent of gsts) {
        const terms: CommercialTerms = { ...T, activationRatePaise, gstRatePercent }
        for (const c of [1, 100, 101, 137, 437, 999, 5_001, 199_999, 200_000]) {
          const q = quote(c, terms)
          for (const v of [q.basePaise, q.gstPaise, q.totalPaise]) {
            expect(Number.isInteger(v), `capacity ${c} rate ${activationRatePaise} gst ${gstRatePercent} → ${v}`).toBe(true)
          }
          expect(q.basePaise + q.gstPaise).toBe(q.totalPaise)
        }
      }
    }
  })
})

// ═══ 5 · RD-CAPACITY-02 FIX · availability must not advertise the bucket ══════
//
// The public event page derived event capacity from `capacityPlan`, which rounds UP: an event
// with `totalCapacity = 437` carries `pack_500`, so the page offered 500. The gate still
// refused at 437, so nothing oversold — the attendee was told there was room and then refused
// at checkout. These assertions pin the fixed contract.

describe('public availability reflects the exact capacity', () => {
  it('a 437-capacity event never reports 500 seats', async () => {
    const { computeEventAvailability } = await import('@/lib/registrations/availability')
    const { deriveStoredEventCapacity, capacityPlanForRegistrationLimit } = await import('@/lib/registrations/capacity')

    // This is exactly what publish stamps for 437: the exact capacity, plus the rounded-up
    // legacy plan. The divergence is real, not hypothetical.
    const event = { totalCapacity: 437, capacityPlan: capacityPlanForRegistrationLimit(437) }
    expect(event.capacityPlan).toBe('pack_500')

    const derived = deriveStoredEventCapacity(event)
    expect(derived).toBe(437)

    const passes = [{ id: 'p1', unlimited: true, quantity: null }]
    const avail = computeEventAvailability(passes, derived, { totalCount: 400, passCounts: { p1: 400 } } as never)
    const p1 = avail.get('p1')!
    expect(p1.eventCapacity).toBe(437)
    expect(p1.remaining).toBe(37)        // not 100
    expect(p1.status).toBe('available')

    // At 437 taken it is sold out — under the old behaviour it would still offer 63 seats.
    const full = computeEventAvailability(passes, derived, { totalCount: 437, passCounts: { p1: 437 } } as never)
    expect(full.get('p1')!.remaining).toBe(0)
    expect(full.get('p1')!.status).toBe('sold_out')
  })

  it('agrees with the registration gate for the same stored document', async () => {
    const { deriveStoredEventCapacity } = await import('@/lib/registrations/capacity')
    // Legacy document with no totalCapacity still derives from the plan — backward compatible.
    expect(deriveStoredEventCapacity({ capacityPlan: 'pack_1000' })).toBe(1_000)
    // Explicit null stays unlimited.
    expect(deriveStoredEventCapacity({ totalCapacity: null })).toBe(null)
    // A number always wins over a divergent plan.
    expect(deriveStoredEventCapacity({ totalCapacity: 437, capacityPlan: 'pack_5000' })).toBe(437)
  })

  it('the call site passes the derived capacity, never the plan', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const src = readFileSync(resolve(process.cwd(), 'app/events/[slug]/page.tsx'), 'utf8')
    expect(src).toContain('deriveStoredEventCapacity(event as Parameters<typeof deriveStoredEventCapacity>[0])')
    expect(src).not.toMatch(/computeEventAvailability\([\s\S]{0,80}capacityPlan/)
  })
})
