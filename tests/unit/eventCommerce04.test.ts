// RD-EVENT-COMMERCE-04 — pure guarantees of the Super Admin ↔ organizer pricing alignment.
// (Route + Firestore behaviour is in tests/emulator/eventCommerce04.emu.test.ts.)

import { describe, it, expect } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  serviceAvailability, validateServiceQuantity, validateServiceAllowances, normalizeServiceAllowances,
  type PrepaidServiceConfig,
} from '@/lib/licensing/serviceAllowances'
import {
  calculateActivationQuote, calculateCapacityIncreaseQuote, quoteCapacityChange,
} from '@/lib/licensing/capacityPricing'
import {
  DEFAULT_COMMERCIAL_TERMS, validateCommercialTerms, normalizeCommercialTerms,
} from '@/lib/licensing/capacityCommercial'
import { LicenseTile } from '@/components/dashboard/LicenseTile'
import type { DashboardLicense } from '@/app/api/organizer/dashboard/route'

const OK: PrepaidServiceConfig = { enabled: true, unitPricePaise: 45, gstRatePercent: 18, minQuantity: 100, maxQuantity: 50_000, presets: [500], onExhausted: 'block' }

describe('service allowances — malformed stored values can never make a service sellable', () => {
  it('a complete, valid entry is purchasable', () => {
    expect(serviceAvailability(OK)).toEqual({ purchasable: true, missing: [] })
  })

  const cases: Array<[string, Partial<Record<keyof PrepaidServiceConfig, unknown>>, string]> = [
    ['negative price',        { unitPricePaise: -45 },    'unit price'],
    ['zero price',            { unitPricePaise: 0 },      'unit price'],
    ['string price',          { unitPricePaise: '45' },   'unit price'],
    ['fractional price',      { unitPricePaise: 4.5 },    'unit price'],
    ['NaN price',             { unitPricePaise: NaN },    'unit price'],
    ['GST over 100',          { gstRatePercent: 150 },    'GST rate'],
    ['NaN GST',               { gstRatePercent: NaN },    'GST rate'],
    ['string GST',            { gstRatePercent: '18' },   'GST rate'],
    ['max below min',         { maxQuantity: 50 },        'quantity range'],
    ['zero minimum',          { minQuantity: 0 },         'quantity range'],
    ['unknown exhaustion',    { onExhausted: 'free' },    'exhaustion policy'],
    ['truthy non-boolean on', { enabled: 'true' },        'enabled for sale'],
  ]
  for (const [name, patch, missing] of cases) {
    it(`${name} ⇒ NOT purchasable (${missing})`, () => {
      const cfg = { ...OK, ...patch } as PrepaidServiceConfig
      const a = serviceAvailability(cfg)
      expect(a.purchasable).toBe(false)
      expect(a.missing).toContain(missing)
      // …and the quantity validator — the gate every route uses — refuses to price it.
      expect(validateServiceQuantity('whatsapp', 500, cfg)).toMatchObject({ ok: false, code: 'NOT_PURCHASABLE' })
    })
  }

  // RD-EVENT-COMMERCE-05A — the defaults are now the APPROVED prices (on sale); an explicitly
  // cleared price (stored null) is still never sellable.
  it('absent ⇒ the approved defaults (sellable); a stored null price ⇒ not for sale', () => {
    const cfg = normalizeServiceAllowances(undefined)
    for (const k of ['whatsapp', 'certificates', 'media'] as const) expect(serviceAvailability(cfg[k]).purchasable).toBe(true)
    const cleared = normalizeServiceAllowances({ whatsapp: { unitPricePaise: null }, certificates: { gstRatePercent: null }, media: { onExhausted: null } })
    for (const k of ['whatsapp', 'certificates', 'media'] as const) expect(serviceAvailability(cleared[k]).purchasable).toBe(false)
  })

  it('save-time validation refuses non-positive / non-integer prices (0 is never a valid unit price)', () => {
    const errs = validateServiceAllowances({ whatsapp: { ...OK, unitPricePaise: 0 }, certificates: { ...OK, unitPricePaise: -1 }, media: { ...OK, gstRatePercent: 101 } })
    expect(errs.join('|')).toMatch(/whatsapp\.unitPricePaise/)
    expect(errs.join('|')).toMatch(/certificates\.unitPricePaise/)
    expect(errs.join('|')).toMatch(/media\.gstRatePercent/)
  })
})

describe('approved capacity contract (100 free · ₹1.50 · 18% GST · 1–200,000)', () => {
  const T = DEFAULT_COMMERCIAL_TERMS
  const total = (capacity: number, terms = T) => {
    const q = calculateActivationQuote({ capacity, terms })
    if (!q.ok) throw new Error(q.message)
    return q.quote
  }

  it('the first 100 slots are free', () => {
    for (const c of [1, 50, 100]) expect(total(c)).toMatchObject({ basePaise: 0, gstPaise: 0, totalPaise: 0 })
  })
  it('each additional slot is ₹1.50 before GST, with 18% GST on top', () => {
    expect(total(101)).toMatchObject({ basePaise: 150, gstPaise: 27, totalPaise: 177 })
    expect(total(437)).toMatchObject({ basePaise: 50_550, gstPaise: 9_099, totalPaise: 59_649 })
    expect(total(200_000)).toMatchObject({ basePaise: 29_985_000, gstPaise: 5_397_300, totalPaise: 35_382_300 })
  })
  it('the range is 1 to 200,000 — 0 and 200,001 are refused', () => {
    expect(calculateActivationQuote({ capacity: 0, terms: T }).ok).toBe(false)
    expect(calculateActivationQuote({ capacity: 200_001, terms: T }).ok).toBe(false)
    expect(calculateActivationQuote({ capacity: '437' as unknown as number, terms: T }).ok).toBe(false)
  })
  it('GST follows the configured rate', () => {
    expect(total(437, { ...T, gstRatePercent: 12 })).toMatchObject({ basePaise: 50_550, gstPaise: 6_066, totalPaise: 56_616 })
  })
  it('an increase charges ONLY the increment (437 → 600 = 163 slots)', () => {
    const q = calculateCapacityIncreaseQuote({ currentCapacity: 437, newCapacity: 600, terms: T })
    expect(q.ok && q.quote).toMatchObject({ basePaise: 24_450, gstPaise: 4_401, totalPaise: 28_851 })
  })
  it('an increase that stays inside the free allowance is free (50 → 100)', () => {
    const q = quoteCapacityChange({ currentCapacity: 50, newCapacity: 100, terms: T })
    expect(q.ok && q.quote.totalPaise).toBe(0)
  })
  it('invalid terms price nothing (INVALID_TERMS), they never fall through to ₹0', () => {
    const bad = { ...T, activationRatePaise: -150 }
    expect(calculateActivationQuote({ capacity: 437, terms: bad })).toMatchObject({ ok: false, code: 'INVALID_TERMS' })
  })
  it('a malformed stored field falls back to the approved value, field by field', () => {
    const t = normalizeCommercialTerms({ activationRatePaise: '999', gstRatePercent: NaN, freeRegistrationCapacity: 100 })
    expect(t).toEqual(DEFAULT_COMMERCIAL_TERMS)
    expect(validateCommercialTerms({ ...T, activationRatePaise: -1 })).not.toHaveLength(0)
  })
})

describe('dashboard licence tile — a capacity licence is not a tier', () => {
  const base: DashboardLicense = {
    scope: 'event', tier: 'capacity', tierName: 'Capacity licence', status: 'active',
    used: 120, limit: 600, remaining: 480, percentUsed: 20, upgrade: null, expiresAt: null, eventCount: 1, unavailable: false,
  }
  it('shows the purchased capacity and points at the License & Services page — no tier upsell', () => {
    const html = renderToStaticMarkup(createElement(LicenseTile, { license: base }))
    expect(html).toContain('Capacity licence')
    expect(html).toContain('600')
    expect(html).toContain('License &amp; Services')
    expect(html).not.toMatch(/Upgrade to/)
    expect(html).not.toMatch(/highest plan/)
  })
  it('a historical tier licence is shown as LEGACY (RD-EVENT-COMMERCE-05: tiers are no longer sold)', () => {
    const html = renderToStaticMarkup(createElement(LicenseTile, { license: { ...base, tier: 'enterprise', tierName: 'Enterprise (legacy)' } }))
    expect(html).toMatch(/Legacy licence — tiers are no longer sold/)
    expect(html).not.toMatch(/Upgrade to/)
  })
})
