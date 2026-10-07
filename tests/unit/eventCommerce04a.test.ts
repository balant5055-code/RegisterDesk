// RD-EVENT-COMMERCE-04A — pure guarantees: groupwise licensing resolution, the stored-commercial
// integrity verdict, per-service isolation, licence-derived capacity, and the FAIL-CLOSED global
// terms resolver. (Firestore / auth behaviour: tests/emulator/eventCommerce04a.emu.test.ts.)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const store = vi.hoisted(() => ({ stored: {} as Record<string, unknown>, loadFailed: false }))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))
vi.mock('@/lib/config/businessConfigService', async () => {
  const { resolveBusinessConfig } = await import('@/lib/config/businessConfig')
  return {
    businessConfig: {
      getStoredLayer: async () => ({ stored: store.stored, loadFailed: store.loadFailed }),
      getSection: async (k: string) => (resolveBusinessConfig(store.stored as never) as unknown as Record<string, unknown>)[k],
    },
  }
})

import { resolveSection, BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'
import { assessStoredCommercialTerms, DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { resolveServiceAllowancesFromStored } from '@/lib/licensing/serviceAllowanceConfig'
import { serviceAvailability } from '@/lib/licensing/serviceAllowances'
import { capacityFromLicenceDoc } from '@/lib/licensing/licensedCapacity'
import { getEventLicenseDefinition, getEventLicenseDefinitionV2 } from '@/lib/licensing/eventLicense'
import {
  getGlobalCommercialTerms, getDisplayCommercialTerms, resolveGlobalCommercialTerms, COMMERCIAL_TERMS_UNAVAILABLE,
} from '@/lib/licensing/resolveCommercialTerms'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'

const CERT = { enabled: true, unitPricePaise: 200, gstRatePercent: 18, minQuantity: 10, maxQuantity: 10_000, presets: [], onExhausted: 'wallet_payg' }

describe('licensing resolves GROUP BY GROUP (one bad group no longer reverts the section)', () => {
  it('a corrupt serviceAllowances group keeps a valid, non-default commercial group', () => {
    const r = resolveSection('licensing', { licensing: { commercial: { activationRatePaise: 300 }, serviceAllowances: { whatsapp: { enabled: 'x' } } } } as never)
    expect(r.commercial.activationRatePaise).toBe(300)
    expect(r.serviceAllowances).toEqual(BUSINESS_CONFIG_DEFAULTS.licensing.serviceAllowances)
  })
  it('a corrupt coupons group keeps valid commercial and purchasesEnabled', () => {
    const r = resolveSection('licensing', { licensing: { commercial: { gstRatePercent: 12 }, coupons: { enabled: 'yes' }, purchasesEnabled: false } } as never)
    expect(r.commercial.gstRatePercent).toBe(12)
    expect(r.purchasesEnabled).toBe(false)
    expect(r.coupons).toEqual(BUSINESS_CONFIG_DEFAULTS.licensing.coupons)
  })
  it('other sections keep the whole-section rule (behaviour unchanged outside licensing)', () => {
    const def = BUSINESS_CONFIG_DEFAULTS.wallet as unknown as Record<string, unknown>
    const key = Object.keys(def)[0]
    const r = resolveSection('wallet', { wallet: { [key]: '__not-valid__' } } as never)
    expect(r).toEqual(BUSINESS_CONFIG_DEFAULTS.wallet)
  })
})

describe('stored commercial integrity — absent vs valid vs corrupt', () => {
  it('absent ⇒ absent (the approved defaults apply)', () => expect(assessStoredCommercialTerms(undefined)).toEqual({ state: 'absent' }))
  it('a valid partial group is valid (missing keys inherit defaults)', () => {
    expect(assessStoredCommercialTerms({ activationRatePaise: 300 })).toEqual({ state: 'valid' })
  })
  it('an explicit ₹0 promotion is VALID, not corruption', () => {
    expect(assessStoredCommercialTerms({ activationRatePaise: 0 })).toEqual({ state: 'valid' })
  })
  const corrupt: Array<[string, unknown]> = [
    ['null value (deepMerge would hide it)', { activationRatePaise: null }],
    ['string number',                        { activationRatePaise: '150' }],
    ['negative',                             { activationRatePaise: -1 }],
    ['fraction of a paisa',                  { activationRatePaise: 1.5 }],
    ['GST above 100',                        { gstRatePercent: 101 }],
    ['NaN GST',                              { gstRatePercent: NaN }],
    ['max below free',                       { maximumEventCapacity: 50 }],
    ['not an object',                        'free'],
    ['array',                                [150]],
  ]
  for (const [name, v] of corrupt) {
    it(`${name} ⇒ invalid`, () => expect(assessStoredCommercialTerms(v).state).toBe('invalid'))
  }
})

describe('prepaid services resolve PER SERVICE', () => {
  it('a corrupt WhatsApp entry leaves a valid certificates entry sellable', () => {
    const cfg = resolveServiceAllowancesFromStored({ whatsapp: { ...CERT, unitPricePaise: -45 }, certificates: CERT })
    expect(serviceAvailability(cfg.whatsapp).purchasable).toBe(false)
    expect(serviceAvailability(cfg.certificates).purchasable).toBe(true)
    expect(cfg.certificates.unitPricePaise).toBe(200)
  })
  it('explicitly cleared fields, malformed types and a non-object group are all NOT for sale', () => {
    // RD-EVENT-COMMERCE-05A — an ABSENT field now takes its approved default; a STORED null does not.
    expect(serviceAvailability(resolveServiceAllowancesFromStored({ certificates: { enabled: true, unitPricePaise: 200, gstRatePercent: null } }).certificates).purchasable).toBe(false)
    expect(serviceAvailability(resolveServiceAllowancesFromStored({ certificates: { enabled: true, unitPricePaise: 200 } }).certificates).purchasable).toBe(true)
    expect(serviceAvailability(resolveServiceAllowancesFromStored({ certificates: { ...CERT, maxQuantity: '10000' } }).certificates).purchasable).toBe(false)
    expect(serviceAvailability(resolveServiceAllowancesFromStored({ certificates: 'on' }).certificates).purchasable).toBe(false)
    const none = resolveServiceAllowancesFromStored('garbage')
    for (const k of ['whatsapp', 'certificates', 'media'] as const) expect(serviceAvailability(none[k]).purchasable).toBe(false)
  })
})

describe('global terms FAIL CLOSED when the stored group cannot be trusted', () => {
  beforeEach(() => { store.stored = {}; store.loadFailed = false })

  it('never configured ⇒ approved defaults, priced normally', async () => {
    expect(await getGlobalCommercialTerms()).toEqual(DEFAULT_COMMERCIAL_TERMS)
    expect(await resolveGlobalCommercialTerms()).toMatchObject({ ok: true, source: 'defaults' })
  })
  it('configured ⇒ the configured values', async () => {
    store.stored = { licensing: { commercial: { activationRatePaise: 300 } } }
    expect((await getGlobalCommercialTerms()).activationRatePaise).toBe(300)
  })
  it('corrupt ⇒ UNAVAILABLE terms that every quote refuses (never the defaults, never an amount)', async () => {
    store.stored = { licensing: { commercial: { activationRatePaise: '300' } } }
    const t = await getGlobalCommercialTerms()
    expect(t).toEqual(COMMERCIAL_TERMS_UNAVAILABLE)
    expect(calculateActivationQuote({ capacity: 437, terms: t })).toMatchObject({ ok: false, code: 'INVALID_TERMS' })
    expect(calculateActivationQuote({ capacity: 50, terms: t })).toMatchObject({ ok: false, code: 'INVALID_TERMS' })  // not even a "free" 50
    expect(await resolveGlobalCommercialTerms()).toMatchObject({ ok: false, reason: 'CONFIG_INVALID' })
  })
  it('unreadable ⇒ refused too (a failed read is not "never configured")', async () => {
    store.loadFailed = true
    expect(await resolveGlobalCommercialTerms()).toMatchObject({ ok: false, reason: 'CONFIG_UNREADABLE' })
    expect(calculateActivationQuote({ capacity: 437, terms: await getGlobalCommercialTerms() }).ok).toBe(false)
  })
  it('display-only surfaces show the approved published model, never the refusal sentinel', async () => {
    store.stored = { licensing: { commercial: { gstRatePercent: 500 } } }
    expect(await getDisplayCommercialTerms()).toEqual(DEFAULT_COMMERCIAL_TERMS)
  })
})

describe('capacity from the licence doc the dashboard already reads (no 200 guess)', () => {
  const cat1 = { starter: getEventLicenseDefinition('starter'), growth: getEventLicenseDefinition('growth'), professional: getEventLicenseDefinition('professional'), enterprise: getEventLicenseDefinition('enterprise') } as never
  const cat2 = Object.fromEntries((['free', 'starter', 'professional', 'business', 'enterprise'] as const).map(t => [t, getEventLicenseDefinitionV2(t)])) as never

  it('capacity model ⇒ the capacity it bought', () => {
    expect(capacityFromLicenceDoc({ commercialModel: 'capacity', tier: 'free', version: 2, capacity: 1206 }, cat1, cat2)).toBe(1206)
  })
  it('capacity model with a missing / malformed capacity ⇒ unknown (null), NOT the free tier', () => {
    for (const capacity of [undefined, null, 0, -5, 12.5, '600']) {
      expect(capacityFromLicenceDoc({ commercialModel: 'capacity', tier: 'free', version: 2, capacity }, cat1, cat2)).toBeNull()
    }
  })
  it('legacy paid tier ⇒ its limit AT ITS STORED VERSION', () => {
    const v2pro = getEventLicenseDefinitionV2('professional').limits.maxRegistrations
    expect(capacityFromLicenceDoc({ tier: 'professional', version: 2 }, cat1, cat2)).toBe(Number.isFinite(v2pro) ? v2pro : null)
    const v1growth = getEventLicenseDefinition('growth').limits.maxRegistrations
    expect(capacityFromLicenceDoc({ tier: 'growth', version: 1 }, cat1, cat2)).toBe(Number.isFinite(v1growth) ? v1growth : null)
  })
  it('no licence / unknown tier / unlimited ⇒ null', () => {
    expect(capacityFromLicenceDoc(null, cat1, cat2)).toBeNull()
    expect(capacityFromLicenceDoc({ tier: 'platinum', version: 2 }, cat1, cat2)).toBeNull()
    expect(capacityFromLicenceDoc({ tier: 'growth', version: 2 }, cat1, cat2)).toBeNull()   // V1-only tier under V2
  })
})

describe('no surface assumes a free event holds 200', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('the dashboard and the event route no longer use the retired Free-tier capacity', () => {
    const DASH = read('app/api/organizer/dashboard/route.ts')
    const EV   = read('app/api/organizer/events/[eventId]/route.ts')
    expect(DASH).not.toMatch(/getFreeEventCapacity\(\)/)
    // RD-FIN-02 · capacity is now the ENFORCED value of the live event (one shared summary), not the licence.
    expect(DASH).toContain('resolveEventCapacitySummary(')
    expect(EV).toContain('resolveEventCapacitySummary(')
    expect(DASH).not.toMatch(/isFree \? freeCapacity/)
    expect(EV).not.toMatch(/getFreeEventCapacity\(\)|freeCapacity/)
    expect(read('lib/licensing/resolveCatalog.ts')).not.toContain('export async function getFreeEventCapacity')
  })
})
