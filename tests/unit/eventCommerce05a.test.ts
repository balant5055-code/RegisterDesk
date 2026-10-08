// RD-EVENT-COMMERCE-05A — approved default service prices, exact rupee ⇄ paise entry, and the
// defaults-vs-stored resolution. (Routes / Firestore: tests/emulator/eventCommerce05.emu.test.ts.)

import { describe, it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/config/businessConfigService', () => ({ businessConfig: {} }))

import { parseRupeesToPaise, paiseToRupeesInput } from '@/lib/licensing/moneyInput'
import {
  DEFAULT_SERVICE_ALLOWANCES, priceServiceItem, serviceAvailability, validateServiceQuantity,
} from '@/lib/licensing/serviceAllowances'
import { resolveServiceCatalogFromStored } from '@/lib/licensing/serviceAllowanceConfig'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { ServiceQuantitySelector } from '@/components/wizard/ServiceQuantitySelector'

describe('rupees typed by a Super Admin become EXACT integer paise', () => {
  it.each([
    ['0.20', 20], ['0.2', 20], ['1.90', 190], ['1.9', 190], ['1.50', 150], ['₹1.90', 190], ['12', 1200], ['1,000.05', 100_005], ['0.01', 1], ['0', 0],
  ])('%s → %i paise', (raw, paise) => {
    expect(parseRupeesToPaise(raw)).toEqual({ ok: true, paise })
  })
  it('never multiplies twice, never goes through a float (1.005-style values are refused, not rounded)', () => {
    expect(parseRupeesToPaise('1.005')).toMatchObject({ ok: false, error: expect.stringMatching(/2 decimal places/) })
    expect(parseRupeesToPaise('0.20').ok && (parseRupeesToPaise('0.20') as { paise: number }).paise).toBe(20)   // not 0.2, not 2000
  })
  it('refuses negatives, text and signs; empty means "not set"', () => {
    for (const bad of ['-1', 'abc', '1.2.3', '+5', '1e2', '.5']) expect(parseRupeesToPaise(bad).ok, bad).toBe(false)
    expect(parseRupeesToPaise('   ')).toEqual({ ok: true, paise: null })
  })
  it('paise are shown back as rupees with two decimals', () => {
    expect(paiseToRupeesInput(20)).toBe('0.20'); expect(paiseToRupeesInput(190)).toBe('1.90'); expect(paiseToRupeesInput(150)).toBe('1.50')
    expect(paiseToRupeesInput(null)).toBe(''); expect(paiseToRupeesInput(0.2)).toBe('')
    for (const p of [1, 20, 150, 190, 100_005]) expect(parseRupeesToPaise(paiseToRupeesInput(p))).toEqual({ ok: true, paise: p })   // round-trip
  })
})

describe('approved default prices and 18% GST', () => {
  it('capacity: first 100 free, ₹1.50 each after, 18% GST (unchanged)', () => {
    expect(DEFAULT_COMMERCIAL_TERMS).toMatchObject({ freeRegistrationCapacity: 100, activationRatePaise: 150, gstRatePercent: 18 })
    const q = calculateActivationQuote({ capacity: 437, terms: DEFAULT_COMMERCIAL_TERMS })
    expect(q.ok && q.quote).toMatchObject({ basePaise: 50_550, gstPaise: 9_099, totalPaise: 59_649 })
  })
  it('WhatsApp ₹0.20, certificate ₹1.50, photo ₹1.60 — GST-exclusive at 18%', () => {
    const wa = priceServiceItem('whatsapp', 1_000, DEFAULT_SERVICE_ALLOWANCES.whatsapp)
    expect(wa).toMatchObject({ unitPricePaise: 20, basePaise: 20_000, gstPaise: 3_600, totalPaise: 23_600 })     // ₹200 + ₹36 = ₹236
    const ce = priceServiceItem('certificates', 100, DEFAULT_SERVICE_ALLOWANCES.certificates)
    expect(ce).toMatchObject({ unitPricePaise: 150, basePaise: 15_000, gstPaise: 2_700, totalPaise: 17_700 })    // ₹150 + ₹27
    const me = priceServiceItem('media', 7, DEFAULT_SERVICE_ALLOWANCES.media)
    expect(me).toMatchObject({ unitPricePaise: 160, basePaise: 1_120, gstPaise: 202, totalPaise: 1_322 })     // 201.6 → 202 (half-up)
  })
  it('no maximum: any whole quantity ≥ 1 is valid; 0 is "none"', () => {
    expect(validateServiceQuantity('whatsapp', 250_000, DEFAULT_SERVICE_ALLOWANCES.whatsapp)).toEqual({ ok: true, quantity: 250_000 })
    expect(validateServiceQuantity('whatsapp', 0, DEFAULT_SERVICE_ALLOWANCES.whatsapp)).toEqual({ ok: true, quantity: 0 })
    expect(validateServiceQuantity('whatsapp', 1.5, DEFAULT_SERVICE_ALLOWANCES.whatsapp)).toMatchObject({ ok: false, code: 'NOT_AN_INTEGER' })
  })
})

describe('defaults apply ONLY where nothing is stored', () => {
  it('unconfigured ⇒ approved defaults, on sale', () => {
    const r = resolveServiceCatalogFromStored(undefined)
    expect(r.config.whatsapp.unitPricePaise).toBe(20); expect(r.config.certificates.unitPricePaise).toBe(150); expect(r.config.media.unitPricePaise).toBe(160)
    expect(r.state).toEqual({ whatsapp: 'available', certificates: 'available', media: 'available' })
  })
  it('a Super Admin’s SAVED price is preserved (never overwritten by a default)', () => {
    const r = resolveServiceCatalogFromStored({ whatsapp: { ...DEFAULT_SERVICE_ALLOWANCES.whatsapp, unitPricePaise: 35, maxQuantity: 10_000 } })
    expect(r.config.whatsapp).toMatchObject({ unitPricePaise: 35, maxQuantity: 10_000 })
    expect(r.config.certificates.unitPricePaise).toBe(150)
  })
  it('saved "not for sale" and saved-cleared values are preserved too', () => {
    const r = resolveServiceCatalogFromStored({ media: { enabled: false }, certificates: { unitPricePaise: null } })
    expect(r.state.media).toBe('disabled'); expect(r.state.certificates).toBe('not_configured')
    expect(serviceAvailability(r.config.certificates).purchasable).toBe(false)
  })
  it('a malformed stored service is invalid — never silently the default price', () => {
    for (const bad of ['on', 5, [], null]) {
      const r = resolveServiceCatalogFromStored({ certificates: bad })
      expect(r.state.certificates, String(bad)).toBe('invalid')
      expect(serviceAvailability(r.config.certificates).purchasable).toBe(false)
    }
  })
})

describe('organizer quantity control with the defaults', () => {
  it('enabled input, price badge, "no maximum" range, and a slider', () => {
    const c = DEFAULT_SERVICE_ALLOWANCES.whatsapp
    const html = renderToStaticMarkup(createElement(ServiceQuantitySelector, {
      title: 'Prepaid WhatsApp messages', unit: 'message', units: 'messages', usageRule: 'r', quantity: 500, onChange: () => {},
      catalog: { ...c, purchasable: true, missing: [], state: 'available' }, item: priceServiceItem('whatsapp', 500, c), error: null,
    } as never))
    expect(html).toContain('₹0.20 / message + 18% GST')
    expect(html).toContain('1 or more · No maximum')
    expect(html).toContain('type="range"')
    expect(html).not.toMatch(/<input[^>]*type="number"[^>]*disabled=""/)
  })
})
