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
import { buildPricingPlans, PLATFORM_FEE_PREFIX } from '@/content/marketing/pricing'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { formatPaise } from '@/lib/licensing/capacityPricing'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const PAGE = read('app/pricing/page.tsx')
/** The page with comments stripped — a comment explaining what was REMOVED is not active
 *  copy, and asserting against it would forbid documenting the change. */
const PAGE_CODE = PAGE
  .split('\n')
  .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  .join('\n')

import { formatTicketFee, type PublicTicketFee } from '@/lib/licensing/publicPricing'
import { getDefaultFeeConfig } from '@/lib/fees/config'

/** The ticket fee a new sale resolves to under the code defaults: the commercial percentage + the canonical row's GST and cap,
 *  with NO fixed part and NO minimum (RD-FEE-01 — resolveFeeConfig zeroes them for ticket sales). */
const FEE_ROW = getDefaultFeeConfig('event_registration', 'starter')
const FEE: PublicTicketFee = {
  percent: DEFAULT_COMMERCIAL_TERMS.attendeeTransactionFeePercent, fixedPaise: 0,
  minPaise: 0, maxPaise: FEE_ROW.platformFeeMaxPaise, gstRatePercent: FEE_ROW.gstRatePercent,
}

const T = DEFAULT_COMMERCIAL_TERMS
const plans = buildPricingPlans(T, FEE)
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

  it('both cards quote the same RegisterDesk platform fee', () => {
    const fees = plans.map(p => p.features.find(f => f.startsWith(PLATFORM_FEE_PREFIX)))
    expect(fees.every(Boolean)).toBe(true)
    expect(new Set(fees).size).toBe(1)
    expect(fees[0]).toContain(`${T.attendeeTransactionFeePercent}%`)
    // RD-PRICING-CALC — the line is the ticket fee the checkout resolves (percent + fixed + GST),
    // not the bare commercial percentage.
    expect(fees[0]).toBe(PLATFORM_FEE_PREFIX + formatTicketFee(FEE))
    // RD-FEE-02 — never called a "transaction fee"; the gateway charge is not part of it.
    for (const p of plans) expect(p.features.join(' ')).not.toMatch(/transaction fee/i)
  })

  it('the paid card states the CONFIGURED GST rate', () => {
    expect(byId.get('payg')!.features.join(' ')).toContain(`GST ${T.gstRatePercent}%`)
  })

  it('moves with configuration — a changed rate changes the card', () => {
    // The property that makes this page safe: it cannot drift from the checkout.
    const cheaper: CommercialTerms = { ...T, activationRatePaise: 50, freeRegistrationCapacity: 250, gstRatePercent: 12, attendeeTransactionFeePercent: 3 }
    const p = buildPricingPlans(cheaper, { percent: 3, fixedPaise: 0, minPaise: 0, maxPaise: 0, gstRatePercent: 0 })
    expect(p[0].features[0]).toContain('250')
    expect(p[1].priceLabel).toBe('₹0.50')
    expect(p[1].features.join(' ')).toContain('GST 12%')
    expect(p[1].features.join(' ')).toContain('RegisterDesk platform fee: 3% on paid ticket sales')
  })

  it('the page resolves the EFFECTIVE pricing, live, and never the code defaults', () => {
    // RD-PRICING-CALC — one snapshot (getPublicPricing) feeds the facts, the cards, the metadata and
    // the calculator, and the page regenerates about once a minute, so an admin change reaches it
    // without a deploy. The DISPLAY resolver (which fell back to the code defaults on a corrupt
    // config) is no longer used: an unresolvable config now shows "unavailable".
    expect(PAGE).toContain('const pricing = await getPublicPricing()')
    expect(PAGE).toContain('buildPricingPlans(pricing.terms, pricing.ticketFee)')
    expect(PAGE).toContain('initialPricing={pricing}')
    expect(PAGE).toMatch(/export const revalidate = 60\b/)
    expect(PAGE_CODE).not.toContain('getDisplayCommercialTerms')
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

// ═══ 4 · the static worked example is replaced by the calculator (RD-PRICING-CALC) ═══
//
// The page used to print one example ('An event accepting 500 registrations'). It now mounts the
// interactive calculator, whose arithmetic is pinned in publicPricingCalculator.test.ts against the
// License & Services quote route. Here: the page carries no figure of its own.

describe('the pricing calculator replaces the static example', () => {
  it('mounts the calculator and no longer renders the static example', () => {
    expect(PAGE_CODE).toContain('<PricingCalculator ')
    expect(PAGE_CODE).not.toMatch(/An event accepting|buildPricingExample|ExampleRow/)
  })

  it('the page never writes an amount or a rate into the markup', () => {
    expect(PAGE_CODE).not.toMatch(/₹\s?\d/)
    expect(PAGE_CODE).not.toMatch(/\b18%|\b1\.50\b/)
  })
})

// ═══ 5 · the two places that CANNOT derive, guarded against drift ════════════
//
// RD-PRICING-CALC — the metadata used to be a static `export const metadata` with the free capacity
// typed into it (pinned here to the constant to catch drift). It is now `generateMetadata`, built
// from the same live pricing as the page, so there is no static number left to drift. Its rendered
// output is checked in publicPricingPage.test.ts; here, the source shape.

describe('the metadata description is derived, not pinned', () => {
  const gen = PAGE.slice(PAGE.indexOf('export async function generateMetadata')).split(/\r?\n\}\r?\n/)[0]

  it('the page metadata names the CONFIGURED free capacity', () => {
    expect(PAGE).not.toMatch(/export const metadata/)
    expect(gen).toContain('pricing.terms.freeRegistrationCapacity')
    expect(gen).not.toMatch(/up to \d/)
  })

  it('the page metadata describes the capacity model, not a tier ladder', () => {
    expect(gen).toMatch(/pay once per event|capacity/i)
    expect(gen).not.toMatch(/tier|one license per event|transaction fees on every/i)
    for (const name of RETIRED) expect(gen, name).not.toContain(name)
  })

  it('"per event" survives, because activation genuinely is once per event', () => {
    // Not a stale tier reference: the charge is one-time, per event. Only the TIER framing went.
    expect(PAGE).toMatch(/pay once per event/i)
  })
})
