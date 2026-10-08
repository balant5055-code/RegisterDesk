// RD-PRICING-CALC — EVERY figure on /pricing comes from the one live public-pricing snapshot.
//
//   A. The published ticket fee IS the fee the ticket checkout resolves for a new sale
//      (resolveEventFeeConfig → getFeePlanForOrganizer → resolveFeeConfig), under several
//      configurations — and its components reproduce the engine's actual charge.
//   B. The page itself — facts ribbon, plan cards, metadata and the calculator seed — renders from
//      that snapshot: change the configuration and the rendered page changes; make it unavailable
//      and NO amount is rendered (never a default, never an old figure).

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { DEFAULT_SERVICE_ALLOWANCES } from '@/lib/licensing/serviceAllowances'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { formatTicketFee, formatPercent, type PublicPricingConfig } from '@/lib/licensing/publicPricing'
import { calculateFee } from '@/lib/fees/engine'

vi.setConfig({ testTimeout: 60_000 })

// ─── A shared, mutable Business Configuration (only what the resolvers read) ───

const state: { fees: Record<string, unknown>; commercial: Partial<CommercialTerms> | undefined; loadFailed: boolean } =
  { fees: {}, commercial: undefined, loadFailed: false }

vi.mock('@/lib/config/businessConfigService', async () => {
  const { BUSINESS_CONFIG_DEFAULTS } = await import('@/lib/config/businessConfig')
  const licensing = () => ({ ...BUSINESS_CONFIG_DEFAULTS.licensing, commercial: { ...DEFAULT_COMMERCIAL_TERMS, ...(state.commercial ?? {}) } })
  return { businessConfig: {
    getStoredLayer: async () => ({ stored: state.commercial ? { licensing: { commercial: state.commercial } } : {}, loadFailed: state.loadFailed }),
    getSection: async (key: string) =>
      key === 'fees' ? { ...BUSINESS_CONFIG_DEFAULTS.fees, ...state.fees }
      : key === 'licensing' ? licensing()
      : (BUSINESS_CONFIG_DEFAULTS as Record<string, unknown>)[key],
  } }
})
// resolveEventFeeConfig reads the event: a fresh event with no commercial override of its own.
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ uid: 'org-1' }) }) }) }) },
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {}, captureFinancialError: () => {} }))

const server = () => import('@/lib/licensing/publicPricingServer')

const FEE_CASES: { name: string; fees: Record<string, unknown>; commercial?: Partial<CommercialTerms> }[] = [
  { name: 'code defaults',                                fees: {} },
  { name: 'a changed commercial attendee percentage',     fees: {}, commercial: { attendeeTransactionFeePercent: 3.75 } },
  { name: 'an explicit admin fees.platformFeePercent',    fees: { platformFeePercent: 4, gstPercent: 12 } },
  { name: 'the platform fee switched off',                fees: { platformFeeEnabled: false } },
  { name: 'GST switched off',                             fees: { gstEnabled: false } },
]

describe('A · the published ticket fee is the checkout’s own resolution', () => {
  beforeEach(() => { vi.resetModules(); state.loadFailed = false; process.env.__PAGE_TEST = '0' })

  for (const c of FEE_CASES) {
    it(`matches resolveEventFeeConfig — ${c.name}`, async () => {
      state.fees = c.fees; state.commercial = c.commercial
      const pricing = await (await server()).getPublicPricing()
      expect(pricing).not.toBeNull()
      const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
      const checkout = await resolveEventFeeConfig('any-new-event')
      if (!checkout.ok) throw new Error('checkout resolution failed')
      const f = pricing!.ticketFee
      expect(f).toEqual({
        percent: checkout.config.platformFeePercentBps / 100, fixedPaise: checkout.config.platformFeeFixedPaise,
        minPaise: checkout.config.platformFeeMinPaise, maxPaise: checkout.config.platformFeeMaxPaise,
        gstRatePercent: checkout.config.gstRatePercent,
      })
      // The described components reproduce what the engine actually charges on a paid ticket.
      for (const gross of [10_000, 49_900, 250_000]) {
        const r = calculateFee({ grossAmountPaise: gross, feeModel: 'organizer_pays', config: checkout.config })
        const raw = Math.round(gross * f.percent / 100) + f.fixedPaise
        const base = f.maxPaise > 0 ? Math.min(f.maxPaise, Math.max(f.minPaise, raw)) : Math.max(f.minPaise, raw)
        expect(r.platformFeeBasePaise, `${c.name} @ ${gross}`).toBe(base)
        expect(r.platformFeeGstPaise).toBe(Math.round(base * f.gstRatePercent / 100))
      }
    })
  }

  it('the fee phrase names every component that is charged, and only those', () => {
    expect(formatTicketFee({ percent: 2.5, fixedPaise: 500, minPaise: 500, maxPaise: 0, gstRatePercent: 18 }))
      .toBe(`${formatPercent(2.5)}% + ${formatPaise(500)} on paid ticket sales + GST`)
    expect(formatTicketFee({ percent: 0, fixedPaise: 500, minPaise: 500, maxPaise: 0, gstRatePercent: 0 }))
      .toBe(`${formatPaise(500)} on paid ticket sales`)
    expect(formatTicketFee({ percent: 1, fixedPaise: 0, minPaise: 0, maxPaise: 50_000, gstRatePercent: 18 }))
      .toBe(`1% on paid ticket sales, capped at ${formatPaise(50_000)} + GST`)
    expect(formatTicketFee({ percent: 2, fixedPaise: 100, minPaise: 900, maxPaise: 0, gstRatePercent: 0 }))
      .toBe(`2% + ${formatPaise(100)} on paid ticket sales (minimum ${formatPaise(900)})`)
    expect(formatTicketFee({ percent: 0, fixedPaise: 0, minPaise: 0, maxPaise: 0, gstRatePercent: 18 })).toBe('No RegisterDesk platform fee')
  })

  it('an unreadable configuration publishes NOTHING (fail closed)', async () => {
    state.loadFailed = true
    expect(await (await server()).getPublicPricing()).toBeNull()
  })
})

// ─── B · the rendered page ────────────────────────────────────────────────────

const page = { pricing: null as PublicPricingConfig | null }
vi.mock('@/lib/licensing/publicPricingServer', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/licensing/publicPricingServer')>()),
  getPublicPricing: async () => (process.env.__PAGE_TEST === '1' ? page.pricing : (await importOriginal<typeof import('@/lib/licensing/publicPricingServer')>()).getPublicPricing()),
}))
vi.mock('@/components/marketing/layout/MarketingPageLayout', () => ({
  MarketingPageLayout: ({ children }: { children: unknown }) => children,
}))

const services = (unit: Partial<Record<'whatsapp' | 'certificates' | 'media', number>> = {}) =>
  Object.fromEntries((['whatsapp', 'certificates', 'media'] as const).map(k => [k, {
    available: true as const, config: { ...DEFAULT_SERVICE_ALLOWANCES[k], unitPricePaise: unit[k] ?? DEFAULT_SERVICE_ALLOWANCES[k].unitPricePaise },
  }])) as PublicPricingConfig['services']

const CONFIG_A: PublicPricingConfig = {
  terms: DEFAULT_COMMERCIAL_TERMS, services: services(),
  ticketFee: { percent: 2.5, fixedPaise: 500, minPaise: 500, maxPaise: 0, gstRatePercent: 18 },
}
const CONFIG_B: PublicPricingConfig = {
  terms: { ...DEFAULT_COMMERCIAL_TERMS, freeRegistrationCapacity: 333, activationRatePaise: 275, gstRatePercent: 12, maximumEventCapacity: 7_777 },
  services: services({ whatsapp: 37 }),
  ticketFee: { percent: 3.75, fixedPaise: 0, minPaise: 0, maxPaise: 0, gstRatePercent: 12 },
}

async function renderPage(): Promise<string> {
  const { default: PricingPage } = await import('@/app/pricing/page')
  return renderToStaticMarkup(await PricingPage() as ReactElement)
}
async function description(): Promise<string> {
  const { generateMetadata } = await import('@/app/pricing/page')
  return String((await generateMetadata()).description ?? '')
}

describe('B · /pricing renders every figure from the live snapshot', () => {
  beforeEach(() => { vi.resetModules(); process.env.__PAGE_TEST = '1' })
  afterAll(() => { delete process.env.__PAGE_TEST })

  for (const [name, cfg] of [['configuration A', CONFIG_A], ['configuration B', CONFIG_B]] as const) {
    it(`facts, cards, metadata and the calculator all show ${name}`, async () => {
      page.pricing = cfg
      const html = await renderPage()
      const t = cfg.terms
      const free = t.freeRegistrationCapacity.toLocaleString('en-IN')
      const rate = formatPaise(t.activationRatePaise)
      // the facts ribbon
      expect(html).toContain(`First ${free} registrations, then ${rate} each`)
      // the plan cards: free allowance, rate, range to the maximum, GST, the resolved ticket fee
      expect(html).toContain(`Up to ${free} registrations`)
      expect(html).toContain(rate)
      expect(html).toContain(`${(t.freeRegistrationCapacity + 1).toLocaleString('en-IN')} – ${t.maximumEventCapacity.toLocaleString('en-IN')} registrations`)
      expect(html).toContain(`GST ${formatPercent(t.gstRatePercent)}% applies to the activation fee`)
      expect(html.split(formatTicketFee(cfg.ticketFee).replace(/&/g, '&amp;')).length - 1).toBeGreaterThanOrEqual(3)   // 2 cards + calculator note
      // the calculator, seeded with the same snapshot (no "loading", same figures)
      expect(html).not.toContain('Loading current pricing')
      expect(html).toContain(`First ${free} free · then ${rate} each`)
      expect(html).toContain(`${formatPaise(cfg.services.whatsapp.available ? cfg.services.whatsapp.config.unitPricePaise! : 0)} per message`)
      // the metadata
      expect(await description()).toContain(`Start free up to ${free} registrations`)
    })
  }

  it('changing the configuration changes the rendered page — nothing is pinned', async () => {
    page.pricing = CONFIG_A
    const a = await renderPage()
    vi.resetModules()
    page.pricing = CONFIG_B
    const b = await renderPage()
    expect(a).toContain(formatPaise(CONFIG_A.terms.activationRatePaise))
    expect(b).not.toContain(`then ${formatPaise(CONFIG_A.terms.activationRatePaise)} each`)
    expect(b).toContain(`then ${formatPaise(CONFIG_B.terms.activationRatePaise)} each`)
  })

  it('pricing UNAVAILABLE: no amount, rate, allowance or fee is rendered — only the unavailable state', async () => {
    page.pricing = null
    const html = await renderPage()
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, '')   // JSON-LD carries no price beyond "Free to start"
    expect(visible).toContain('Pricing is temporarily unavailable. Please try again.')
    expect(visible).toContain('Current pricing is temporarily unavailable')
    expect(visible).not.toMatch(/₹\s?\d/)
    expect(visible).not.toMatch(/\d+(\.\d+)?%/)
    expect(visible).not.toMatch(/First \d|Up to \d/)
    expect(await description()).not.toMatch(/\d/)
  })

  it('the page regenerates about once a minute (no deploy needed for a price change)', async () => {
    const mod = await import('@/app/pricing/page') as { revalidate?: number }
    expect(mod.revalidate).toBe(60)
  })
})
