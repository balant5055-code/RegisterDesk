// RD-EVENT-COMMERCE-05 — pure guarantees: per-service sale state, save-time readiness rules,
// the one organizer-facing wording, and the retired tier surfaces.
// End to end (config route → quote → order → verified grant → consume → buy more):
// tests/emulator/eventCommerce05.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  serviceSaleState, serviceSaleReadinessErrors, saleStateMessage, normalizeServiceAllowances,
  type PrepaidServiceConfig,
} from '@/lib/licensing/serviceAllowances'
import { resolveServiceCatalogFromStored } from '@/lib/licensing/serviceAllowanceConfig'
import { ServiceQuantitySelector } from '@/components/wizard/ServiceQuantitySelector'
import { LicenseTile } from '@/components/dashboard/LicenseTile'

vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: {} }))

const WA: PrepaidServiceConfig = { enabled: true, unitPricePaise: 45, gstRatePercent: 18, minQuantity: 100, maxQuantity: 50_000, presets: [500], onExhausted: 'block' }

describe('every not-for-sale reason is distinct', () => {
  it('available / not priced / paused', () => {
    expect(serviceSaleState(WA)).toBe('available')
    expect(serviceSaleState({ ...WA, unitPricePaise: null })).toBe('not_configured')
    expect(serviceSaleState({ ...WA, enabled: false })).toBe('disabled')
    expect(serviceSaleState({ ...WA, enabled: false, gstRatePercent: null })).toBe('not_configured')
  })
  it('stored corruption is "invalid" (never sold, never the defaults); absent ⇒ the approved defaults; a stored null ⇒ "not_configured"', () => {
    const r = resolveServiceCatalogFromStored({ whatsapp: WA, certificates: { ...WA, unitPricePaise: 'x' } })
    expect(r.state).toEqual({ whatsapp: 'available', certificates: 'invalid', media: 'available', print_badges: 'not_released' })   // RD-PRINT-BILL-P1: print_badges is catalog-only and not for sale
    expect(r.config.certificates.unitPricePaise).toBeNull()                    // NOT the ₹1.50 default
    expect(r.config.media.unitPricePaise).toBe(160)                            // absent ⇒ approved default
    const garbage = resolveServiceCatalogFromStored('garbage')
    expect(garbage.state).toEqual({ whatsapp: 'invalid', certificates: 'invalid', media: 'invalid', print_badges: 'invalid' })
    expect(garbage.config.whatsapp.unitPricePaise).toBeNull()
    expect(resolveServiceCatalogFromStored(undefined).state).toEqual({ whatsapp: 'available', certificates: 'available', media: 'available', print_badges: 'not_released' })
    expect(resolveServiceCatalogFromStored({ whatsapp: { unitPricePaise: null } }).state.whatsapp).toBe('not_configured')
  })
  it('the organizer sentence names the actual reason', () => {
    expect(saleStateMessage('whatsapp', 'not_configured', ['unit price', 'GST rate', 'enabled for sale'])).toMatch(/hasn’t set the unit price, GST rate\./)
    expect(saleStateMessage('certificates', 'disabled')).toMatch(/paused sales of prepaid certificates/)
    expect(saleStateMessage('media', 'invalid')).toMatch(/correcting their pricing/)
    expect(saleStateMessage('whatsapp', 'unavailable')).toMatch(/couldn’t be loaded/)
    expect(saleStateMessage('whatsapp', 'available')).toBe('')
  })
})

describe('save-time readiness (Super Admin publish)', () => {
  it('"for sale" with a pricing decision missing is refused, naming what to set', () => {
    const errs = serviceSaleReadinessErrors({ whatsapp: { ...WA, unitPricePaise: null, onExhausted: null } })
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/WhatsApp message allowance: set its unit price, exhaustion policy before putting it on sale/)
  })
  it('presets outside min…max are refused', () => {
    expect(serviceSaleReadinessErrors({ whatsapp: { ...WA, presets: [50, 500, 60_000] } })[0]).toMatch(/quick-select 50, 60000 must lie within 100–50000/)
  })
  it('an incomplete service that is NOT for sale may be saved (a draft of the pricing)', () => {
    expect(serviceSaleReadinessErrors({ whatsapp: { ...WA, enabled: false, unitPricePaise: null } })).toEqual([])
    expect(serviceSaleReadinessErrors(normalizeServiceAllowances(undefined))).toEqual([])
  })
})

describe('organizer controls show the specific state', () => {
  const base = { title: 'Prepaid WhatsApp messages', unit: 'message', units: 'messages', usageRule: 'rule', quantity: 0, onChange: () => {}, item: null, error: null }
  const cat = (state: string, stateMessage: string) => ({ purchasable: false, missing: [], state, stateMessage, minQuantity: 1, maxQuantity: null, presets: [], unitPricePaise: null, gstRatePercent: null, onExhausted: null })
  it('paused → "Sales paused" + the reason; never "Awaiting configuration"', () => {
    const html = renderToStaticMarkup(createElement(ServiceQuantitySelector, { ...base, catalog: cat('disabled', 'RegisterDesk has paused sales of prepaid messages.') } as never))
    expect(html).toContain('Sales paused'); expect(html).toContain('paused sales'); expect(html).not.toContain('Awaiting configuration')
  })
  it('server error → "Temporarily unavailable", not "not priced"', () => {
    const html = renderToStaticMarkup(createElement(ServiceQuantitySelector, { ...base, catalog: null, unavailable: true } as never))
    expect(html).toContain('Temporarily unavailable'); expect(html).toContain('couldn’t be loaded')
  })
  it('available → price badge and an ENABLED quantity input', () => {
    const html = renderToStaticMarkup(createElement(ServiceQuantitySelector, { ...base, catalog: { purchasable: true, missing: [], state: 'available', minQuantity: 100, maxQuantity: 50_000, presets: [500], unitPricePaise: 45, gstRatePercent: 18, onExhausted: 'block' } } as never))
    expect(html).toContain('₹0.45 / message + 18% GST')
    expect(html).not.toMatch(/<input[^>]*type="number"[^>]*disabled=""/)
  })
})

describe('no tier is offered as a purchase any more', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('admin licence surfaces have no Upgrade / Downgrade / Grant tier controls', () => {
    for (const f of ['app/(admin)/admin/licenses/PageClient.tsx', 'app/(admin)/admin/license-center/PageClient.tsx', 'app/(admin)/admin/events/[slug]/PageClient.tsx']) {
      const s = read(f)
      expect(s, f).not.toMatch(/label="Upgrade"|label="Downgrade"|label="Grant\/Comp"|promptTier|Select tier/)
    }
    expect(read('app/(admin)/admin/organizers/[organizerUid]/PageClient.tsx')).not.toMatch(/Set \/ clear entitlement override|Override tier/)
  })
  it('the server refuses tier grant / upgrade / downgrade outright (410)', () => {
    const s = read('lib/admin/licenseAdminService.ts')
    expect(s).toMatch(/action === 'grant' \|\| action === 'upgrade' \|\| action === 'downgrade'[\s\S]{0,200}410/)
    expect(s).not.toMatch(/case 'upgrade':/)
  })
  it('organizer surfaces offer no tier upgrade (licence detail always null; dashboard next null)', () => {
    expect(read('app/api/organizer/licenses/[eventId]/route.ts')).toContain("const upgrade: LicenseCenterDetail['upgrade'] = null")
    const html = renderToStaticMarkup(createElement(LicenseTile, { license: {
      scope: 'event', tier: 'professional', tierName: 'Professional (legacy)', status: 'active', used: 10, limit: 1000, remaining: 990,
      percentUsed: 1, upgrade: null, expiresAt: null, eventCount: 1, unavailable: false } }))
    expect(html).toContain('Legacy licence — tiers are no longer sold.')
    expect(html).not.toMatch(/Upgrade to/)
  })
})
