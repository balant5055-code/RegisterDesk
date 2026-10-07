// RD-CAPACITY-02 — /pricing renders the CAPACITY model, from the effective terms.
//
// ═══ WHAT THIS FILE USED TO PIN, AND WHY IT CHANGED ══════════════════════════
// It asserted five tier cards with exact figures — Starter ₹999 struck from ₹1,299,
// Professional ₹1,499, "Unlimited registrations" on Enterprise. Every one of those was a
// promise about a product RegisterDesk no longer sells, so the assertions could not be kept:
// a prospect read a tier price here and then met a capacity slider in the builder.
//
// The file's actual VALUE survives unchanged and is what is re-pinned below: the page may not
// invent a figure. It renders what the commercial configuration says, or it renders nothing.
// That is why every expectation here is computed from the terms rather than typed as a literal
// — a rate change in configuration must never need an edit to this file, while a rate change
// that the PAGE fails to pick up must fail here.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildPricingPlans, buildPricingExample } from '@/content/marketing/pricing'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { calculateActivationQuote, formatPaise } from '@/lib/licensing/capacityPricing'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const PAGE = read('app/pricing/page.tsx')
/** The page with comments stripped — a comment explaining what was REMOVED is not active
 *  copy, and asserting against it would forbid documenting the change. */
const PAGE_CODE = PAGE
  .split('\n')
  .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n')

const T = DEFAULT_COMMERCIAL_TERMS
const plans = buildPricingPlans(T)
const byId = new Map(plans.map(p => [p.id, p]))
const RETIRED = ['Starter', 'Professional', 'Business', 'Enterprise']

// ═══ 1 · two states, not five tiers ═══════════════════════════════════════════

describe('the page offers exactly two commercial states', () => {
  it('renders Free and Pay as you go, in that order', () => {
    expect(plans.map(p => p.id)).toEqual(['free', 'payg'])
    expect(plans.map(p => p.name)).toEqual(['Free', 'Pay as you go'])
  })

  it('names no retired tier, anywhere in the built plans', () => {
    const blob = JSON.stringify(plans)
    for (const name of RETIRED) expect(blob, `plans still mention ${name}`).not.toContain(name)
  })

  it('names no retired tier in the ACTIVE page copy', () => {
    // Hero, metadata, headings and JSON-LD. Comments are excluded: the file documents which
    // tiers it stopped rendering, and that note is the opposite of a stale promise.
    for (const name of RETIRED) expect(PAGE_CODE, `/pricing still renders ${name}`).not.toContain(name)
  })

  it('highlights exactly one card', () => {
    expect(plans.filter(p => p.highlighted)).toHaveLength(1)
    expect(byId.get('payg')!.highlighted).toBe(true)
  })

  it('no longer advertises a per-event licence or a tier ladder', () => {
    expect(PAGE).not.toMatch(/One license per event/i)
    expect(PAGE).not.toMatch(/every tier/i)
    expect(PAGE).not.toMatch(/Choose the right event license/i)
  })
})

// ═══ 2 · every figure is derived, none is typed ═══════════════════════════════

describe('every figure comes from the commercial terms', () => {
  it('the free card states the CONFIGURED free capacity', () => {
    const free = byId.get('free')!
    expect(free.features[0]).toBe(`Up to ${T.freeRegistrationCapacity.toLocaleString('en-IN')} registrations`)
    expect(free.priceLabel).toBe('Free')
    expect(free.period).toBeNull()
  })

  it('the paid card states the CONFIGURED rate and range', () => {
    const payg = byId.get('payg')!
    expect(payg.priceLabel).toBe(formatPaise(T.activationRatePaise))
    expect(payg.features[0]).toBe(
      `${(T.freeRegistrationCapacity + 1).toLocaleString('en-IN')} – ${T.maximumEventCapacity.toLocaleString('en-IN')} registrations`,
    )
  })

  it('both cards quote the same attendee transaction fee', () => {
    const fees = plans.map(p => p.features.find(f => /transaction fee/i.test(f)))
    expect(new Set(fees).size).toBe(1)
    expect(fees[0]).toContain(`${T.attendeeTransactionFeePercent}%`)
  })

  it('the paid card states the CONFIGURED GST rate', () => {
    expect(byId.get('payg')!.features.join(' ')).toContain(`GST ${T.gstRatePercent}%`)
  })

  it('moves with configuration — a changed rate changes the card', () => {
    // The property that makes this page safe: it cannot drift from the checkout.
    const cheaper: CommercialTerms = { ...T, activationRatePaise: 50, freeRegistrationCapacity: 250, gstRatePercent: 12, attendeeTransactionFeePercent: 3 }
    const p = buildPricingPlans(cheaper)
    expect(p[0].features[0]).toContain('250')
    expect(p[1].priceLabel).toBe('₹0.50')
    expect(p[1].features.join(' ')).toContain('GST 12%')
    expect(p[1].features.join(' ')).toContain('3% transaction fee')
  })

  it('the page resolves the EFFECTIVE terms, not code defaults', () => {
    // Business Configuration is layered over the code defaults, so an admin rate change reaches
    // the public page without a deploy. RD-EVENT-COMMERCE-04A: the page uses the DISPLAY resolver
    // (same configured values; the approved model if the stored group is corrupt — charging
    // paths refuse in that case, the public page does not show a sentinel).
    expect(PAGE).toContain('await getDisplayCommercialTerms()')
    expect(PAGE).toContain('buildPricingPlans(terms)')
    expect(PAGE).not.toContain('getLicenseCatalogV2')
  })
})

// ═══ 3 · both cards say everything is included ═══════════════════════════════

describe('features are no longer a differentiator', () => {
  it('both cards say no feature is held back by plan', () => {
    // RD-PREPROD · softened from "Every RegisterDesk feature included": what the code proves is
    // that no feature is GATED by plan (capacityFeatureGatesRemoved), not that every advertised
    // capability is live — custom domains have no host routing yet.
    for (const p of plans) {
      expect(p.features, `${p.name} does not say features are included`)
        .toEqual(expect.arrayContaining([expect.stringMatching(/All available features — no feature plans/)]))
      expect(p.features.join(' ')).not.toMatch(/Every RegisterDesk feature/i)
    }
  })

  it('neither card lists a capability the other lacks', () => {
    // Under the old model the cards differed by feature bullets. Now the only difference is
    // capacity and price, so no card may claim an exclusive capability.
    const free = new Set(byId.get('free')!.features)
    const payg = new Set(byId.get('payg')!.features)
    const exclusiveCapabilities = [...payg].filter(f =>
      !free.has(f) && !/registrations|GST|activation|per registration/i.test(f))
    expect(exclusiveCapabilities).toEqual([])
  })

  it('no card advertises the waitlist while it is switched off', () => {
    // Carried forward from the original invariant: a bullet is a promise, and the waitlist
    // kill switch is still false platform-wide.
    for (const p of plans) expect(p.features.join(' '), `${p.name} card`).not.toMatch(/wait-?list/i)
    expect(read('lib/registrations/gate.ts')).toMatch(/const waitlistEnabled = WAITLIST_ENABLED &&/)
  })
})

// ═══ 4 · the worked example is priced by the REAL engine ═════════════════════

describe('the worked example', () => {
  it('matches what the activation quote would actually charge', () => {
    const ex = buildPricingExample(T, 500)
    expect(ex).not.toBeNull()
    const q = calculateActivationQuote({ capacity: 500, terms: T })
    if (!q.ok) throw new Error('quote rejected')
    // Not recomputed here — compared against the engine, which is the point.
    expect(ex!.base).toBe(formatPaise(q.quote.basePaise))
    expect(ex!.gst).toBe(formatPaise(q.quote.gstPaise))
    expect(ex!.total).toBe(formatPaise(q.quote.totalPaise))
    expect(ex!.chargeable).toBe(q.quote.chargeableCapacity.toLocaleString('en-IN'))
  })

  it('is the ₹708 figure the business stated', () => {
    expect(buildPricingExample(T, 500)!.total).toBe('₹708')
  })

  it('returns null rather than inventing a figure it cannot price', () => {
    // A maximum below the example capacity must omit the block, not clamp or fabricate it.
    expect(buildPricingExample({ ...T, maximumEventCapacity: 300 }, 500)).toBeNull()
  })

  it('the page omits the block when there is nothing to show', () => {
    expect(PAGE).toContain('{example && (')
    // …and never falls back to a hardcoded amount.
    expect(PAGE).not.toMatch(/₹7?0?8|₹1,?50/)
  })

  it('the page asks for an example within the configured maximum', () => {
    expect(PAGE).toContain('Math.min(500, terms.maximumEventCapacity)')
  })
})

// ═══ 5 · the two places that CANNOT derive, guarded against drift ════════════
//
// `export const metadata` is evaluated at module load, so it cannot await the config resolver
// the way the page body does. The numbers in it are therefore static — which is exactly the
// drift that produced the original /pricing-vs-FAQ contradiction. The same guard the FAQ uses
// applies here: the sentence is checked against the canonical constant, so changing the free
// capacity without updating the description fails.

describe('static copy that cannot derive is pinned to the constants', () => {
  const description = (PAGE.match(/description:\s*'([^']+)'/) ?? [])[1] ?? ''

  it('the page metadata names the configured free capacity', () => {
    expect(description, 'no metadata description found').not.toBe('')
    expect(description).toContain(String(T.freeRegistrationCapacity))
  })

  it('the page metadata describes the capacity model, not a tier ladder', () => {
    expect(description).toMatch(/pay once per event|capacity/i)
    expect(description).not.toMatch(/tier|one license per event|transaction fees on every/i)
    for (const name of RETIRED) expect(description, name).not.toContain(name)
  })

  it('"per event" survives, because activation genuinely is once per event', () => {
    // Not a stale tier reference: the charge is one-time, per event. Only the TIER framing went.
    expect(PAGE).toMatch(/pay once per event/i)
  })
})
