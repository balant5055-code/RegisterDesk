// RD-PRINT-BILL-P1 — Print Badges billing, Phase 1 foundations (pure; no Firestore).
//   A. a stored service-allowance configuration WITHOUT print_badges (production's) resolves
//      unchanged — the live WhatsApp/certificate/photo prices never fall back to defaults;
//   B. print_badges is priced GST-INCLUSIVE (₹0.20 incl. GST) and GST is never added again,
//      while every existing service prices exactly as before (byte-for-byte lines);
//   C. print_badges is registered in the catalog but cannot be selected, quoted or bought.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  SERVICE_KINDS, CATALOG_SERVICE_KINDS, CATALOG_ONLY_SERVICE_KINDS, SERVICE_PRICE_MODE, SERVICE_LABELS,
  DEFAULT_SERVICE_ALLOWANCES, EMPTY_SELECTION,
  validateServiceAllowances, normalizeServiceAllowances, serviceAvailability, serviceSaleState, serviceSaleReadinessErrors,
  parseServiceSelection, priceServiceItem, isConsistentServiceItem, inclusiveTaxablePaise, validateServiceQuantity,
  type PrepaidServiceConfig, type ServiceChargeItem, type CatalogServiceKind,
} from '@/lib/licensing/serviceAllowances'
import { applyPercentPaise } from '@/lib/licensing/capacityPricing'
import { resolveServiceCatalogFromStored } from '@/lib/licensing/serviceAllowanceConfig'
import { resolveSection, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { computeTicketTax } from '@/lib/platform/pricing/tax'

// Same isolation as the existing catalog tests: the resolver module imports the config service.
vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: {} }))

// A stored group shaped like production's: the three original services only, with prices a
// Super Admin changed away from the code defaults (so a fallback to defaults would be visible).
const STORED_PROD_LIKE = {
  whatsapp:     { enabled: true,  unitPricePaise: 25,  gstRatePercent: 18, minQuantity: 10, maxQuantity: null, presets: [100, 500], onExhausted: 'block' },
  certificates: { enabled: true,  unitPricePaise: 175, gstRatePercent: 18, minQuantity: 1,  maxQuantity: 5000, presets: [],        onExhausted: 'block' },
  media:        { enabled: false, unitPricePaise: 160, gstRatePercent: 18, minQuantity: 1,  maxQuantity: null, presets: [],        onExhausted: 'block' },
}
const PRINT_ON: PrepaidServiceConfig = { enabled: true, unitPricePaise: 20, gstRatePercent: 18, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' }

// The ORIGINAL (pre-P1) exclusive line formula, kept here verbatim as the reference.
const originalLine = (service: string, q: number, cfg: PrepaidServiceConfig) => {
  const unit = cfg.unitPricePaise ?? 0, rate = cfg.gstRatePercent ?? 0
  const basePaise = q * unit, gstPaise = applyPercentPaise(basePaise, rate)
  return { service, quantity: q, unitPricePaise: unit, basePaise, gstRatePercent: rate, gstPaise, totalPaise: basePaise + gstPaise, onExhausted: cfg.onExhausted ?? 'block' }
}

describe('A · backward-compatible configuration (stored group without print_badges)', () => {
  it('validation: an absent catalog-only service is NOT an error; the original services stay required', () => {
    expect(validateServiceAllowances(STORED_PROD_LIKE)).toEqual([])
    const noWhatsapp: Record<string, unknown> = { ...STORED_PROD_LIKE }
    delete noWhatsapp.whatsapp
    expect(validateServiceAllowances(noWhatsapp)).toEqual(['licensing.serviceAllowances.whatsapp must be an object'])
    // Present but invalid print_badges is still caught.
    expect(validateServiceAllowances({ ...STORED_PROD_LIKE, print_badges: { ...PRINT_ON, unitPricePaise: -1 } }))
      .toEqual(['licensing.serviceAllowances.print_badges.unitPricePaise must be a positive integer (paise) or null'])
    expect(validateServiceAllowances({ ...STORED_PROD_LIKE, print_badges: 'on' })).toEqual(['licensing.serviceAllowances.print_badges must be an object'])
  })

  it('Business Configuration: the stored group is KEPT (no fallback to code defaults) and print_badges resolves to its default', () => {
    const licensing = resolveSection('licensing', { licensing: { serviceAllowances: STORED_PROD_LIKE } } as never)
    const sa = licensing.serviceAllowances!
    expect(sa.whatsapp).toEqual(STORED_PROD_LIKE.whatsapp)
    expect(sa.certificates).toEqual(STORED_PROD_LIKE.certificates)
    expect(sa.media).toEqual(STORED_PROD_LIKE.media)
    expect(sa.print_badges).toEqual(BUSINESS_CONFIG_DEFAULTS.licensing.serviceAllowances!.print_badges)
    // The other licensing groups are untouched by the new service.
    expect(licensing.commercial).toEqual(BUSINESS_CONFIG_DEFAULTS.licensing.commercial)
  })

  it('catalog resolver: existing services resolve exactly as stored, with their old sale states; print_badges is not for sale', () => {
    const r = resolveServiceCatalogFromStored(STORED_PROD_LIKE)
    for (const k of SERVICE_KINDS) expect(r.config[k]).toEqual(STORED_PROD_LIKE[k])
    expect(r.state).toMatchObject({ whatsapp: 'available', certificates: 'available', media: 'disabled' })
    expect(r.config.print_badges).toEqual(DEFAULT_SERVICE_ALLOWANCES.print_badges)
    expect(r.state.print_badges).toBe('not_released')              // RD-PRINT-BILL-P2: the code release gate outranks config
    // A corrupt stored print_badges is judged alone — siblings unaffected.
    const bad = resolveServiceCatalogFromStored({ ...STORED_PROD_LIKE, print_badges: { unitPricePaise: 'x' } })
    expect(bad.state.print_badges).toBe('invalid')
    for (const k of SERVICE_KINDS) expect(bad.config[k]).toEqual(STORED_PROD_LIKE[k])
    // Unreadable/invalid group: nothing (print_badges included) is ever sold.
    expect(Object.values(resolveServiceCatalogFromStored('corrupt').state).every(s => s === 'invalid')).toBe(true)
    expect(Object.keys(resolveServiceCatalogFromStored('corrupt').config).sort()).toEqual([...CATALOG_SERVICE_KINDS].sort())
  })

  it('normalize fills every catalog service; save-time readiness ignores an absent print_badges', () => {
    expect(Object.keys(normalizeServiceAllowances(STORED_PROD_LIKE)).sort()).toEqual([...CATALOG_SERVICE_KINDS].sort())
    expect(serviceSaleReadinessErrors(STORED_PROD_LIKE)).toEqual([])
    // Putting it on sale without a GST rate is refused at save time (never assumed).
    expect(serviceSaleReadinessErrors({ ...STORED_PROD_LIKE, print_badges: { ...DEFAULT_SERVICE_ALLOWANCES.print_badges, enabled: true } })[0])
      .toMatch(/ID badge allowance: set its GST rate/)
  })
})

describe('B · GST-inclusive pricing for print badges; existing services unchanged', () => {
  it('₹0.20 per badge INCLUDING GST: 100 badges cost exactly ₹20.00 — GST is extracted, never added', () => {
    const line = priceServiceItem('print_badges', 100, PRINT_ON)
    expect(line).toEqual({
      service: 'print_badges', quantity: 100, unitPricePaise: 20, basePaise: 1695, gstRatePercent: 18, gstPaise: 305,
      totalPaise: 2000, onExhausted: 'block', priceMode: 'inclusive',
    })
    for (const q of [100, 101, 250, 999, 1000, 4321, 100_000]) {
      const l = priceServiceItem('print_badges', q, PRINT_ON)
      expect(l.totalPaise).toBe(q * 20)                              // payable = qty × inclusive price
      expect(l.basePaise + l.gstPaise).toBe(l.totalPaise)            // the split always sums to the total
      expect(isConsistentServiceItem(l)).toBe(true)
    }
  })

  it('the inclusive split matches the platform inclusive tax rule exactly', () => {
    for (const rate of [0, 5, 12, 18, 28]) {
      for (const gross of [0, 1, 19, 20, 2000, 2001, 99_999, 1_234_567]) {
        const t = computeTicketTax(gross, { enabled: true, mode: 'inclusive', percent: rate, label: 'GST', hsnSac: null, interState: true })
        expect(inclusiveTaxablePaise(gross, rate)).toBe(t.taxableAmountPaise)
      }
    }
  })

  it('uses the CONFIGURED rate — no rate is assumed', () => {
    expect(priceServiceItem('print_badges', 100, { ...PRINT_ON, gstRatePercent: 5 })).toMatchObject({ totalPaise: 2000, basePaise: 1905, gstPaise: 95, gstRatePercent: 5 })
    expect(DEFAULT_SERVICE_ALLOWANCES.print_badges.gstRatePercent).toBeNull()
    expect(serviceAvailability(DEFAULT_SERVICE_ALLOWANCES.print_badges).missing).toContain('GST rate')
  })

  it('WhatsApp, certificates and photos price exactly as before — same values, same keys, no price mode', () => {
    const cfgs: Record<string, PrepaidServiceConfig> = {
      ...DEFAULT_SERVICE_ALLOWANCES, ...(STORED_PROD_LIKE as Record<string, PrepaidServiceConfig>),
    }
    for (const k of SERVICE_KINDS) {
      for (const cfg of [DEFAULT_SERVICE_ALLOWANCES[k], cfgs[k], { ...cfgs[k], gstRatePercent: 12.5 }, { ...cfgs[k], gstRatePercent: 0 }]) {
        for (const q of [1, 3, 7, 100, 1001, 99_999]) {
          const line = priceServiceItem(k, q, cfg)
          expect(line).toStrictEqual(originalLine(k, q, cfg))
          expect(Object.keys(line)).toEqual(Object.keys(originalLine(k, q, cfg)))
          expect('priceMode' in line).toBe(false)
          expect(isConsistentServiceItem(line)).toBe(true)
        }
      }
    }
    // The approved defaults' headline prices (RD-PRICE-01) are untouched.
    expect(priceServiceItem('whatsapp', 100, DEFAULT_SERVICE_ALLOWANCES.whatsapp)).toMatchObject({ basePaise: 2000, gstPaise: 360, totalPaise: 2360 })
    expect(priceServiceItem('certificates', 10, DEFAULT_SERVICE_ALLOWANCES.certificates)).toMatchObject({ basePaise: 1500, gstPaise: 270, totalPaise: 1770 })
    expect(priceServiceItem('media', 10, DEFAULT_SERVICE_ALLOWANCES.media)).toMatchObject({ basePaise: 1600, gstPaise: 288, totalPaise: 1888 })
    expect(Object.fromEntries(SERVICE_KINDS.map(k => [k, SERVICE_PRICE_MODE[k]]))).toEqual({ whatsapp: 'exclusive', certificates: 'exclusive', media: 'exclusive' })
  })

  it('stored-line consistency: the mode must match the service both ways; tampering is refused', () => {
    const inc = priceServiceItem('print_badges', 100, PRINT_ON) as ServiceChargeItem<CatalogServiceKind>
    expect(isConsistentServiceItem({ ...inc, priceMode: undefined })).toBe(false)          // inclusive service, marker removed
    expect(isConsistentServiceItem({ ...inc, gstPaise: 360, totalPaise: 2360 })).toBe(false)  // GST added on top
    expect(isConsistentServiceItem({ ...inc, basePaise: 1694 })).toBe(false)
    const exc = priceServiceItem('whatsapp', 100, DEFAULT_SERVICE_ALLOWANCES.whatsapp) as ServiceChargeItem<CatalogServiceKind>
    expect(isConsistentServiceItem({ ...exc, priceMode: 'inclusive' })).toBe(false)       // exclusive service claiming inclusive
    // An exclusive-shaped print_badges line (GST added) is refused.
    expect(isConsistentServiceItem({ ...originalLine('print_badges', 100, PRINT_ON) } as ServiceChargeItem<CatalogServiceKind>)).toBe(false)
  })
})

describe('C · registered, but NOT selectable, quotable or purchasable', () => {
  it('the selectable list and the stored selection shape are unchanged', () => {
    expect([...SERVICE_KINDS]).toEqual(['whatsapp', 'certificates', 'media'])
    expect(EMPTY_SELECTION).toEqual({ whatsapp: 0, certificates: 0, media: 0 })
    expect([...CATALOG_ONLY_SERVICE_KINDS]).toEqual(['print_badges'])
    expect(SERVICE_LABELS.print_badges).toEqual({ title: 'ID badge allowance', unit: 'badge', units: 'badges' })
  })

  it('a selection naming print_badges is refused (release gate, P2)', () => {
    expect(parseServiceSelection({ print_badges: 100 })).toEqual({ ok: false, message: 'Prepaid badges aren’t available for purchase yet.' })   // RD-PRINT-BILL-P2: refused by name
    expect(parseServiceSelection({ whatsapp: 5 })).toEqual({ ok: true, selection: { whatsapp: 5, certificates: 0, media: 0 } })
  })

  it('the default is disabled, minimum 100 badges at 20 paise, blocked when exhausted — and not purchasable', () => {
    expect(DEFAULT_SERVICE_ALLOWANCES.print_badges).toEqual({ enabled: false, unitPricePaise: 20, gstRatePercent: null, minQuantity: 100, maxQuantity: null, presets: [], onExhausted: 'block' })
    expect(serviceSaleState(DEFAULT_SERVICE_ALLOWANCES.print_badges)).toBe('not_configured')
    expect(validateServiceQuantity('whatsapp' as never, 100, DEFAULT_SERVICE_ALLOWANCES.print_badges)).toMatchObject({ ok: false, code: 'NOT_PURCHASABLE' })
    expect(BUSINESS_CONFIG_DEFAULTS.licensing.serviceAllowances!.print_badges.enabled).toBe(false)
  })

  it('no selection / quote / purchase / activation / organizer path references the catalog-only service', () => {
    const PURCHASE_PATHS = [
      'app/api/licensing/checkout/quote/route.ts', 'app/api/licensing/purchase/route.ts', 'app/api/licensing/published/purchase/route.ts',
      'lib/licensing/draftCoverage.ts', 'lib/licensing/draftCommerce.ts', 'lib/licensing/capacityChange.ts', 'lib/licensing/finalizeLicensePurchase.ts',
      'lib/licensing/publicPricing.ts', 'lib/licensing/publicPricingServer.ts', 'components/wizard/LicenseServicesStep.tsx',
      'components/wizard/LicenseCostSummary.tsx', 'app/api/events/publish/route.ts',
    ]
    for (const f of PURCHASE_PATHS) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/print_badges|CATALOG_SERVICE_KINDS|CATALOG_ONLY_SERVICE_KINDS/)
    }
  })
  // RD-PRINT-BILL-P6 (approved 2026-10-12) — lib/wallet/purchaseIntent.ts now names `print_badges`
  // so the Wallet hand-off lands on License & Services' SEPARATE ID-badge section. It stays pure
  // navigation: it never prices, quotes or buys anything, so the combined licence checkout above
  // still cannot sell badges.
  it('the purchase hand-off only navigates — no request, price or purchase', () => {
    const src = readFileSync('lib/wallet/purchaseIntent.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(src).not.toMatch(/fetch\(|\/api\/|Paise|checkout|quote/i)
  })
})
