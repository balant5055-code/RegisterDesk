// RD-PRICING-CALC — the public /pricing calculator prices EXACTLY like License & Services.
//
// The proof does not re-derive any arithmetic. For every case it runs BOTH real server routes
// against the SAME stubbed Business Configuration:
//
//   A. GET  /api/public/pricing        → the sanitized payload → parsePublicPricingConfig →
//                                        estimateEventCost (what the browser computes)
//   B. POST /api/licensing/checkout/quote (draft mode, nothing paid — a brand-new event)
//
// and asserts the two agree line by line and in total. Only authentication and the two config
// reads are stubbed; the pricing code under test is the production code on both sides. The cases
// run under the approved defaults AND under a deliberately unusual configuration, so a value
// hardcoded anywhere in the calculator path would make the second set fail.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Each case imports both route modules fresh (vi.resetModules), so the first import is slow.
vi.setConfig({ testTimeout: 60_000 })
import { readFileSync } from 'node:fs'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'
import {
  DEFAULT_SERVICE_ALLOWANCES, SERVICE_KINDS, type ServiceAllowancesConfig, type ServiceKind, type ServiceSaleState,
} from '@/lib/licensing/serviceAllowances'
import { MAX_EVENT_PHOTO_CAPACITY } from '@/lib/licensing/photoCapacity'
import {
  estimateEventCost, parsePublicPricingConfig, serviceLimits, registrationLimits,
  type EstimateSelection, type PublicPricingConfig,
} from '@/lib/licensing/publicPricing'
import { sliderStops } from '@/components/marketing/pricing/PricingCalculator'

// ─── The configuration both routes read ─────────────────────────────────────

const cfg: {
  commercial: { ok: true; terms: CommercialTerms; source: 'configured' } | { ok: false; reason: 'CONFIG_INVALID'; errors: string[] }
  catalog:    { config: ServiceAllowancesConfig; state: Record<ServiceKind, ServiceSaleState> }
} = { commercial: { ok: true, terms: DEFAULT_COMMERCIAL_TERMS, source: 'configured' }, catalog: { config: DEFAULT_SERVICE_ALLOWANCES, state: { whatsapp: 'available', certificates: 'available', media: 'available' } } }

vi.mock('@/lib/licensing/resolveCommercialTerms', () => ({
  resolveGlobalCommercialTerms: async () => cfg.commercial,
  getGlobalCommercialTerms:     async () => (cfg.commercial.ok ? cfg.commercial.terms : { ...DEFAULT_COMMERCIAL_TERMS, activationRatePaise: -1 }),
}))
vi.mock('@/lib/licensing/serviceAllowanceConfig', () => ({ getServiceCatalog: async () => cfg.catalog }))
// The ticket-fee resolver (resolveFeeConfig) reads Business Configuration sections: the REAL code
// defaults, with the licensing commercial group following the case's terms.
vi.mock('@/lib/config/businessConfigService', async () => {
  const { BUSINESS_CONFIG_DEFAULTS } = await import('@/lib/config/businessConfig')
  return { businessConfig: { getSection: async (key: keyof typeof BUSINESS_CONFIG_DEFAULTS) =>
    key === 'licensing'
      ? { ...BUSINESS_CONFIG_DEFAULTS.licensing, commercial: cfg.commercial.ok ? cfg.commercial.terms : BUSINESS_CONFIG_DEFAULTS.licensing.commercial }
      : BUSINESS_CONFIG_DEFAULTS[key] } }
})
vi.mock('@/lib/team/workspace', () => ({
  authorizeWorkspace: async () => ({ ok: true, workspaceUid: 'ws-test', callerUid: 'ws-test', permissions: ['events'] }),
}))
// A brand-new event (no eventId) must not read Firestore at all — any access fails the test.
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: new Proxy({}, { get: () => { throw new Error('Firestore must not be read for a new-event quote') } }),
}))

const publicRoute = () => import('@/app/api/public/pricing/route')
const quoteRoute  = () => import('@/app/api/licensing/checkout/quote/route')

async function publicConfig(): Promise<PublicPricingConfig> {
  const res = await (await publicRoute()).GET()
  expect(res.status).toBe(200)
  const parsed = parsePublicPricingConfig(((await res.json()) as { pricing: unknown }).pricing)
  if (!parsed) throw new Error('public payload did not parse')
  return parsed
}

type QuoteBody = {
  capacity: { ok: boolean; code?: string; quote?: { basePaise: number; gstPaise: number; totalPaise: number; chargeableCapacity: number } }
  services: Record<ServiceKind, { ok: boolean; code?: string; item?: { basePaise: number; gstPaise: number; totalPaise: number } | null }>
  totals:   { basePaise: number; gstPaise: number; totalPaise: number }
  payable:  { totalPaise: number } | null
}

async function checkoutQuote(sel: EstimateSelection): Promise<QuoteBody | { rejected: 400 }> {
  const req = new Request('http://localhost/api/licensing/checkout/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: JSON.stringify({ capacity: sel.registrations, services: { whatsapp: sel.whatsapp, certificates: sel.certificates, media: sel.media } }),
  })
  const res = await (await quoteRoute()).POST(req as never)
  // The route rejects a malformed service quantity (negative / fractional) for the whole request.
  if (res.status === 400) return { rejected: 400 }
  expect(res.status).toBe(200)
  return await res.json() as QuoteBody
}

/** The core assertion: the calculator and License & Services agree on every line and the total. */
async function expectSameAsLicenseAndServices(sel: EstimateSelection) {
  const est = estimateEventCost(await publicConfig(), sel)
  const r   = await checkoutQuote(sel)
  if ('rejected' in r) {
    // License & Services refuses the whole request; the calculator must refuse that line and show no total.
    expect(SERVICE_KINDS.some(k => !est.services[k].ok), 'a refused service line').toBe(true)
    expect(est.totals).toBeNull()
    return est
  }
  const q = r

  expect(est.registrations.ok, 'registration validity').toBe(q.capacity.ok)
  if (est.registrations.ok && q.capacity.quote) {
    expect(est.registrations.quote.basePaise).toBe(q.capacity.quote.basePaise)
    expect(est.registrations.quote.gstPaise).toBe(q.capacity.quote.gstPaise)
    expect(est.registrations.quote.totalPaise).toBe(q.capacity.quote.totalPaise)
    expect(est.registrations.quote.chargeableCapacity).toBe(q.capacity.quote.chargeableCapacity)
  } else if (!est.registrations.ok) {
    expect(est.registrations.code).toBe(q.capacity.code)
  }
  for (const k of SERVICE_KINDS) {
    const e = est.services[k], s = q.services[k]
    expect(e.ok, `${k} validity`).toBe(s.ok)
    if (e.ok && s.ok) {
      expect(e.item?.basePaise ?? 0, `${k} base`).toBe(s.item?.basePaise ?? 0)
      expect(e.item?.gstPaise ?? 0,  `${k} gst`).toBe(s.item?.gstPaise ?? 0)
      expect(e.item?.totalPaise ?? 0, `${k} total`).toBe(s.item?.totalPaise ?? 0)
    } else if (!e.ok && !s.ok) {
      expect(e.code, `${k} refusal code`).toBe(s.code)
    }
  }
  // A total is only shown when License & Services would also let it be paid.
  if (q.payable) {
    expect(est.totals).not.toBeNull()
    expect(est.totals).toEqual({ basePaise: q.totals.basePaise, gstPaise: q.totals.gstPaise, totalPaise: q.totals.totalPaise })
    expect(est.totals!.totalPaise).toBe(q.payable.totalPaise)
  } else {
    expect(est.totals).toBeNull()
  }
  return est
}

const sel = (registrations: number, whatsapp = 0, certificates = 0, media = 0): EstimateSelection => ({ registrations, whatsapp, certificates, media })

const UNUSUAL_TERMS: CommercialTerms = {
  freeRegistrationCapacity: 250, activationRatePaise: 275, gstRatePercent: 12,
  attendeeTransactionFeePercent: 3, capacityDecreaseFeePercent: 2, maximumEventCapacity: 7_500,
}
const UNUSUAL_CATALOG: ServiceAllowancesConfig = {
  whatsapp:     { ...DEFAULT_SERVICE_ALLOWANCES.whatsapp,     unitPricePaise: 37,  gstRatePercent: 5,  minQuantity: 50, maxQuantity: 9_000 },
  certificates: { ...DEFAULT_SERVICE_ALLOWANCES.certificates, unitPricePaise: 333, gstRatePercent: 28 },
  media:        { ...DEFAULT_SERVICE_ALLOWANCES.media,        unitPricePaise: 149, gstRatePercent: 18, maxQuantity: 1_200 },
}
const ALL_AVAILABLE = { whatsapp: 'available', certificates: 'available', media: 'available' } as Record<ServiceKind, ServiceSaleState>

const CONFIGS = [
  { name: 'the approved default configuration', terms: DEFAULT_COMMERCIAL_TERMS, catalog: DEFAULT_SERVICE_ALLOWANCES },
  { name: 'an unusual Super Admin configuration', terms: UNUSUAL_TERMS, catalog: UNUSUAL_CATALOG },
]

for (const c of CONFIGS) {
  describe(`calculator = License & Services · ${c.name}`, () => {
    beforeEach(() => {
      vi.resetModules()
      cfg.commercial = { ok: true, terms: c.terms, source: 'configured' }
      cfg.catalog = { config: c.catalog, state: ALL_AVAILABLE }
    })
    const free = c.terms.freeRegistrationCapacity

    it('registrations BELOW the free allowance cost nothing', async () => {
      const est = await expectSameAsLicenseAndServices(sel(free - 1))
      expect(est.totals!.totalPaise).toBe(0)
    })
    it('registrations EXACTLY at the free allowance cost nothing', async () => {
      const est = await expectSameAsLicenseAndServices(sel(free))
      expect(est.totals!.totalPaise).toBe(0)
    })
    it('registrations ABOVE the free allowance are charged per extra registration', async () => {
      const est = await expectSameAsLicenseAndServices(sel(free + 1))
      expect(est.registrations.ok && est.registrations.quote.chargeableCapacity).toBe(1)
      await expectSameAsLicenseAndServices(sel(free + 400))
    })
    it('WhatsApp quantity', async () => { await expectSameAsLicenseAndServices(sel(free + 10, 2_000)) })
    it('certificate quantity', async () => { await expectSameAsLicenseAndServices(sel(free + 10, 0, 500)) })
    it('photo quantity', async () => { await expectSameAsLicenseAndServices(sel(free + 10, 0, 0, 1_000)) })
    it('all services together', async () => { await expectSameAsLicenseAndServices(sel(free + 377, 2_345, 611, 999)) })
    it('zero optional services', async () => {
      const est = await expectSameAsLicenseAndServices(sel(free + 50, 0, 0, 0))
      for (const k of SERVICE_KINDS) expect(est.services[k]).toEqual({ ok: true, item: null })
    })
    it('GST and rounding — quantities that leave fractional paise of GST', async () => {
      for (const s of [sel(free + 337, 7), sel(free + 1, 1, 1, 1), sel(free + 3, 13, 9, 11)]) {
        await expectSameAsLicenseAndServices(s)
      }
    })
    it('the maximum registrations, and the maximum photos', async () => {
      await expectSameAsLicenseAndServices(sel(c.terms.maximumEventCapacity))
      const photoMax = serviceLimits(await publicConfig(), 'media').max!
      await expectSameAsLicenseAndServices(sel(free, 0, 0, photoMax))
    })
    it('invalid quantities are refused the same way (never priced as free)', async () => {
      for (const s of [
        sel(c.terms.maximumEventCapacity + 1), sel(0), sel(-5), sel(100.5),
        sel(free, -1), sel(free, 0, 2.5), sel(free, 0, 0, MAX_EVENT_PHOTO_CAPACITY + 1),
      ]) {
        const est = await expectSameAsLicenseAndServices(s)
        expect(est.totals).toBeNull()
      }
    })
  })
}

describe('a service that is not on sale', () => {
  beforeEach(() => {
    vi.resetModules()
    cfg.commercial = { ok: true, terms: DEFAULT_COMMERCIAL_TERMS, source: 'configured' }
    cfg.catalog = { config: { ...DEFAULT_SERVICE_ALLOWANCES, certificates: { ...DEFAULT_SERVICE_ALLOWANCES.certificates, enabled: false } }, state: { ...ALL_AVAILABLE, certificates: 'disabled' } }
  })
  it('is published with NO price, and refused for any quantity — exactly like the checkout', async () => {
    const pub = await publicConfig()
    expect(pub.services.certificates).toEqual({ available: false, state: 'disabled' })
    await expectSameAsLicenseAndServices(sel(500, 0, 10))
    await expectSameAsLicenseAndServices(sel(500, 0, 0))   // 0 = not buying = still fine
  })
})

// ─── The public endpoint ─────────────────────────────────────────────────────

describe('GET /api/public/pricing', () => {
  beforeEach(() => {
    vi.resetModules()
    cfg.commercial = { ok: true, terms: UNUSUAL_TERMS, source: 'configured' }
    cfg.catalog = { config: UNUSUAL_CATALOG, state: ALL_AVAILABLE }
  })

  it('reflects the configured prices — a Super Admin change needs no code change', async () => {
    const pub = await publicConfig()
    expect(pub.terms).toEqual(UNUSUAL_TERMS)
    expect(pub.services.whatsapp).toEqual({ available: true, config: UNUSUAL_CATALOG.whatsapp })
  })

  it('exposes only the terms and on-sale service settings — nothing else', async () => {
    const body = await (await (await publicRoute()).GET()).json() as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['pricing'])
    const pricing = body.pricing as Record<string, unknown>
    expect(Object.keys(pricing).sort()).toEqual(['services', 'terms', 'ticketFee'])
    expect(Object.keys(pricing.ticketFee as object).sort()).toEqual(['fixedPaise', 'gstRatePercent', 'maxPaise', 'minPaise', 'percent'])
    expect(Object.keys(pricing.terms as object).sort()).toEqual(Object.keys(UNUSUAL_TERMS).sort())
    const json = JSON.stringify(body)
    for (const banned of ['secret', 'key', 'token', 'password', 'uid', 'version', 'updatedBy', 'audit']) {
      expect(json.toLowerCase(), banned).not.toContain(banned.toLowerCase())
    }
  })

  it('fails CLOSED with 503 when the commercial configuration is invalid — no default prices', async () => {
    cfg.commercial = { ok: false, reason: 'CONFIG_INVALID', errors: ['licensing.commercial.activationRatePaise …'] }
    const res = await (await publicRoute()).GET()
    expect(res.status).toBe(503)
    const body = await res.json() as Record<string, unknown>
    expect(body.code).toBe('PRICING_UNAVAILABLE')
    expect(body).not.toHaveProperty('pricing')
  })

  it('is read-only: GET is the only exported handler', async () => {
    const mod = await publicRoute() as Record<string, unknown>
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(mod[verb], verb).toBeUndefined()
    expect(typeof mod.GET).toBe('function')
  })

  it('is cacheable for a short time only, so a price change shows up within about a minute', async () => {
    const res = await (await publicRoute()).GET()
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0, s-maxage=60')
  })
})

// ─── The browser side: malformed data and limits ─────────────────────────────

describe('the calculator trusts only well-formed configuration', () => {
  it('refuses malformed or partial payloads (the page then shows "unavailable")', () => {
    expect(parsePublicPricingConfig(null)).toBeNull()
    expect(parsePublicPricingConfig({})).toBeNull()
    expect(parsePublicPricingConfig({ terms: { ...DEFAULT_COMMERCIAL_TERMS, activationRatePaise: -1 }, services: {} })).toBeNull()
    expect(parsePublicPricingConfig({ terms: DEFAULT_COMMERCIAL_TERMS, services: { whatsapp: { available: true, config: {} } } })).toBeNull()
  })

  it('takes its limits from the configuration and the shared photo maximum', () => {
    const pub: PublicPricingConfig = {
      terms: UNUSUAL_TERMS,
      services: Object.fromEntries(SERVICE_KINDS.map(k => [k, { available: true, config: UNUSUAL_CATALOG[k] }])) as PublicPricingConfig['services'],
    }
    expect(registrationLimits(pub)).toEqual({ min: 1, max: UNUSUAL_TERMS.maximumEventCapacity })
    expect(serviceLimits(pub, 'whatsapp')).toEqual({ min: 0, max: 9_000 })
    expect(serviceLimits(pub, 'certificates')).toEqual({ min: 0, max: null })
    expect(serviceLimits(pub, 'media')).toEqual({ min: 0, max: 1_200 })   // the tighter of config and per-event max
    const open = { ...pub, services: { ...pub.services, media: { available: true as const, config: { ...UNUSUAL_CATALOG.media, maxQuantity: null } } } }
    expect(serviceLimits(open, 'media').max).toBe(MAX_EVENT_PHOTO_CAPACITY)
  })

  it('slider stops always include both ends and stay sorted within range', () => {
    for (const [min, max] of [[1, 200_000], [0, 3_000], [1, 7_500], [0, 10_000], [1, 1]] as const) {
      const s = sliderStops(min, max)
      expect(s[0]).toBe(min); expect(s.at(-1)).toBe(max)
      expect([...s].sort((a, b) => a - b)).toEqual(s)
      expect(new Set(s).size).toBe(s.length)
      expect(s.length).toBeLessThan(300)   // usable on a phone
    }
  })
})

// ─── No second pricing model ─────────────────────────────────────────────────

describe('no price is written into the calculator path', () => {
  const strip = (src: string) => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  const files = ['components/marketing/pricing/PricingCalculator.tsx', 'lib/licensing/publicPricing.ts', 'app/api/public/pricing/route.ts']

  it('contains no rupee amount, no GST percentage and no rate literal', () => {
    for (const f of files) {
      const code = strip(readFileSync(f, 'utf8'))
      expect(code, f).not.toMatch(/₹\s?\d/)
      expect(code, f).not.toMatch(/\b(18|28|12)\s*%/)
      expect(code, f).not.toMatch(/\b(150|160|190|20)\b(?!\d)\s*[,)}\]]/)   // the default paise rates
      expect(code, f).not.toMatch(/gstRatePercent\s*[:=]\s*\d/)
      expect(code, f).not.toMatch(/unitPricePaise\s*[:=]\s*\d/)
      expect(code, f).not.toMatch(/activationRatePaise\s*[:=]\s*\d/)
    }
  })

  it('prices only through the License & Services functions', () => {
    const lib = readFileSync('lib/licensing/publicPricing.ts', 'utf8')
    expect(lib).toContain('calculateActivationQuote({ capacity: selection.registrations, terms: config.terms })')
    expect(lib).toContain('priceServiceItem(kind, check.quantity, cfg)')
    expect(lib).toContain('validateServiceQuantity(kind, selection[kind], cfg)')
    expect(lib).toContain('checkPhotoPurchase(0, check.quantity)')
    const ui = readFileSync('components/marketing/pricing/PricingCalculator.tsx', 'utf8')
    expect(ui).toContain('estimateEventCost(config, selection)')
    expect(ui).toContain("fetch('/api/public/pricing')")
    expect(ui).not.toMatch(/\bbasePaise\s*\*|\*\s*gstRatePercent|Math\.round\(/)   // no arithmetic of its own
  })
})
