// RD-PRODUCT-01E — ticket-tax computation (lib/platform/pricing/tax.ts) + the
// Organization→Event→Pass config resolver (lib/platform/pricing/taxProfile.ts).
//
// taxProfile.ts imports firebase-admin transitively; we exercise only the PURE
// resolveTaxConfig + computeTicketTax, but must stub env before that import loads.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import { computeTicketTax, EXEMPT_TAX, type TaxConfig } from '@/lib/platform/pricing/tax'
import { resolveTaxConfig, validateOrganizationTaxProfile } from '@/lib/platform/pricing/taxProfile'
import { validatePricingSummary } from '@/lib/platform/pricing/validation'
import { createOrderPricingSnapshot, validateOrderPricingSnapshot } from '@/lib/platform/pricing/orderSnapshot'
import { buildPricingSummary } from '../fixtures/pricingSummary'

const cfg = (over: Partial<TaxConfig>): TaxConfig => ({ ...EXEMPT_TAX, enabled: true, mode: 'exclusive', percent: 18, ...over })

describe('computeTicketTax — exempt / disabled', () => {
  it('exempt config yields zero tax, taxable = gross', () => {
    const t = computeTicketTax(100000, EXEMPT_TAX)
    expect(t.exempt).toBe(true)
    expect(t.taxAmountPaise).toBe(0)
    expect(t.taxableAmountPaise).toBe(100000)
    expect(t.grossWithTaxPaise).toBe(100000)
  })

  it('enabled but 0% or ₹0 gross → exempt', () => {
    expect(computeTicketTax(100000, cfg({ percent: 0 })).taxAmountPaise).toBe(0)
    expect(computeTicketTax(0, cfg({})).taxAmountPaise).toBe(0)
  })
})

describe('computeTicketTax — exclusive (tax added on top)', () => {
  it('18% on ₹1000 → ₹180 tax, gross-with-tax ₹1180', () => {
    const t = computeTicketTax(100000, cfg({ mode: 'exclusive', percent: 18 }))
    expect(t.taxableAmountPaise).toBe(100000)
    expect(t.taxAmountPaise).toBe(18000)
    expect(t.grossWithTaxPaise).toBe(118000)
  })
})

describe('computeTicketTax — inclusive (tax extracted from within)', () => {
  it('18% inclusive in ₹1180 → base ₹1000, tax ₹180, gross unchanged', () => {
    const t = computeTicketTax(118000, cfg({ mode: 'inclusive', percent: 18 }))
    expect(t.taxableAmountPaise).toBe(100000)
    expect(t.taxAmountPaise).toBe(18000)
    expect(t.grossWithTaxPaise).toBe(118000)
  })
})

describe('computeTicketTax — CGST/SGST/IGST split', () => {
  it('intra-state splits into CGST + SGST summing to total (no drift)', () => {
    const t = computeTicketTax(100000, cfg({ interState: false, percent: 18 }))
    expect(t.igstPaise).toBe(0)
    expect(t.cgstPaise + t.sgstPaise).toBe(t.taxAmountPaise)
  })

  it('odd tax amount still balances (cgst floored, sgst remainder)', () => {
    const t = computeTicketTax(100001, cfg({ interState: false, percent: 18 }))
    expect(t.cgstPaise + t.sgstPaise).toBe(t.taxAmountPaise)
    expect(t.sgstPaise - t.cgstPaise).toBeLessThanOrEqual(1)
  })

  it('inter-state uses IGST only', () => {
    const t = computeTicketTax(100000, cfg({ interState: true, percent: 18 }))
    expect(t.cgstPaise).toBe(0)
    expect(t.sgstPaise).toBe(0)
    expect(t.igstPaise).toBe(t.taxAmountPaise)
  })
})

describe('resolveTaxConfig — Organization → Event → Pass hierarchy', () => {
  const profile = { enabled: true, taxEnabled: true, defaultTaxMode: 'exclusive' as const, defaultGstPercent: 18, state: 'Karnataka', taxLabel: 'GST' }

  it('absent / disabled profile → EXEMPT (backward compatible)', () => {
    expect(resolveTaxConfig(null).enabled).toBe(false)
    expect(resolveTaxConfig({ enabled: false, taxEnabled: true }).enabled).toBe(false)
    expect(resolveTaxConfig({ enabled: true, taxEnabled: false }).enabled).toBe(false)
  })

  it('org defaults apply when no overrides', () => {
    const c = resolveTaxConfig(profile)
    expect(c.enabled).toBe(true)
    expect(c.mode).toBe('exclusive')
    expect(c.percent).toBe(18)
  })

  it('event override wins over org', () => {
    const c = resolveTaxConfig(profile, { event: { mode: 'inclusive', percent: 12 } })
    expect(c.mode).toBe('inclusive')
    expect(c.percent).toBe(12)
  })

  it('pass override wins over event; useEventTax defers back', () => {
    const withPass = resolveTaxConfig(profile, { event: { percent: 12 }, pass: { percent: 5 } })
    expect(withPass.percent).toBe(5)
    const defer = resolveTaxConfig(profile, { event: { percent: 12 }, pass: { useEventTax: true, percent: 5 } })
    expect(defer.percent).toBe(12)
  })

  it('event exempt override → EXEMPT', () => {
    expect(resolveTaxConfig(profile, { event: { exempt: true } }).enabled).toBe(false)
  })

  it('inter-state derived from supply state vs buyer state', () => {
    expect(resolveTaxConfig(profile, { buyerState: 'Karnataka' }).interState).toBe(false)
    expect(resolveTaxConfig(profile, { buyerState: 'Maharashtra' }).interState).toBe(true)
    expect(resolveTaxConfig(profile, { buyerState: null }).interState).toBe(false)
  })
})

describe('tax flows through PricingSummary → Order Snapshot immutably', () => {
  it('a summary carrying a tax breakdown passes validation and seals into the checksum', () => {
    const summary = { ...buildPricingSummary(), tax: computeTicketTax(100000, cfg({ mode: 'exclusive', percent: 18 })) }
    expect(validatePricingSummary(summary)).toEqual({ ok: true })

    const snap = createOrderPricingSnapshot(summary)
    expect(snap.tax?.taxAmountPaise).toBe(18000)
    expect(validateOrderPricingSnapshot(snap)).toEqual({ ok: true })

    // Tampering with the sealed tax is detected by the checksum.
    const tampered = { ...snap, tax: { ...snap.tax!, taxAmountPaise: 0 } }
    expect(validateOrderPricingSnapshot(tampered).ok).toBe(false)
  })

  it('a summary WITHOUT tax stays valid (backward compatible)', () => {
    const summary = buildPricingSummary()
    expect(summary.tax).toBeUndefined()
    expect(validatePricingSummary(summary)).toEqual({ ok: true })
    expect(validateOrderPricingSnapshot(createOrderPricingSnapshot(summary))).toEqual({ ok: true })
  })

  it('validation rejects an internally inconsistent tax breakdown', () => {
    const bad = { ...buildPricingSummary(), tax: { ...computeTicketTax(100000, cfg({ percent: 18 })), cgstPaise: 999 } }
    expect(validatePricingSummary(bad).ok).toBe(false)
  })
})

describe('validateOrganizationTaxProfile', () => {
  it('accepts a valid GSTIN + PAN', () => {
    expect(validateOrganizationTaxProfile({ gstin: '29ABCDE1234F1Z5', pan: 'ABCDE1234F' })).toEqual([])
  })
  it('rejects malformed GSTIN / PAN / percent', () => {
    expect(validateOrganizationTaxProfile({ gstin: 'BAD' }).length).toBeGreaterThan(0)
    expect(validateOrganizationTaxProfile({ pan: 'bad' }).length).toBeGreaterThan(0)
    expect(validateOrganizationTaxProfile({ defaultGstPercent: 150 }).length).toBeGreaterThan(0)
  })
})
