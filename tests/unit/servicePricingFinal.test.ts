// RD-PRICE-01 (2026-10-07) — the FINAL approved service prices, end to end over the pure layers.
//
//   Registration  first 100 free, then ₹1.50 each   + 18% GST   (licensing.commercial)
//   WhatsApp      ₹0.20 per unit                    + 18% GST   (licensing.serviceAllowances.whatsapp)
//   Certificates  ₹1.50 each                        + 18% GST   (licensing.serviceAllowances.certificates)
//   Photos        ₹1.60 each, max 3,000 per event   + 18% GST   (licensing.serviceAllowances.media)
//
// Every figure below is produced by the production functions from Business Configuration (the code
// defaults stand in for "nothing stored"); none is re-derived here. Historical purchases are valued
// at their FROZEN paid line, never at today's price. The ticket platform fee is a separate model.
// The route-level proof (public /pricing payload = License & Services quote) is
// tests/unit/publicPricingCalculator.test.ts; quote → order → grant on Firestore is
// tests/emulator/eventCommerce05.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { calculateActivationQuote } from '@/lib/licensing/capacityPricing'
import {
  DEFAULT_SERVICE_ALLOWANCES, priceServiceItem, validateServiceQuantity, isConsistentServiceItem, type ServiceChargeItem,
} from '@/lib/licensing/serviceAllowances'
import { resolveServiceCatalogFromStored } from '@/lib/licensing/serviceAllowanceConfig'
import { checkPhotoPurchase, MAX_EVENT_PHOTO_CAPACITY } from '@/lib/licensing/photoCapacity'
import { estimateEventCost, type PublicPricingConfig } from '@/lib/licensing/publicPricing'
import {
  valueUnits, requestEligibility, REFUND_WINDOW_MS, type ServiceState, type EligibilityContext,
} from '@/lib/wallet/serviceRequestRules'

const T = DEFAULT_COMMERCIAL_TERMS
const S = DEFAULT_SERVICE_ALLOWANCES

/** The public /pricing configuration exactly as getPublicPricing builds it when nothing is stored. */
const publicConfig = (ticketPercent = T.attendeeTransactionFeePercent): PublicPricingConfig => ({
  terms: { ...T },
  services: { whatsapp: { available: true, config: S.whatsapp }, certificates: { available: true, config: S.certificates }, media: { available: true, config: S.media } },
  ticketFee: { percent: ticketPercent, fixedPaise: 0, minPaise: 0, maxPaise: 0, gstRatePercent: 18 },
})

describe('Business Configuration — the approved values', () => {
  it('registration: 100 free, ₹1.50 each after, 18% GST; maximum event capacity unchanged', () => {
    expect(T).toMatchObject({ freeRegistrationCapacity: 100, activationRatePaise: 150, gstRatePercent: 18, maximumEventCapacity: 200_000 })
  })
  it('services: WhatsApp ₹0.20, certificate ₹1.50, photo ₹1.60 — all 18% GST, all on sale', () => {
    expect([S.whatsapp.unitPricePaise, S.certificates.unitPricePaise, S.media.unitPricePaise]).toEqual([20, 150, 160])
    expect([S.whatsapp.gstRatePercent, S.certificates.gstRatePercent, S.media.gstRatePercent]).toEqual([18, 18, 18])
    const r = resolveServiceCatalogFromStored(undefined)
    expect(r.state).toEqual({ whatsapp: 'available', certificates: 'available', media: 'available', print_badges: 'not_released' })   // RD-PRINT-BILL-P1: print_badges is catalog-only and not for sale
    expect([r.config.whatsapp.unitPricePaise, r.config.certificates.unitPricePaise, r.config.media.unitPricePaise]).toEqual([20, 150, 160])
  })
  it('a price a Super Admin SAVED still wins over the code default (production needs its stored value edited)', () => {
    const r = resolveServiceCatalogFromStored({ certificates: { ...S.certificates, unitPricePaise: 190 }, media: { ...S.media, unitPricePaise: 190 } })
    expect([r.config.certificates.unitPricePaise, r.config.media.unitPricePaise]).toEqual([190, 190])
    expect(r.config.whatsapp.unitPricePaise).toBe(20)
  })
})

describe('Registration — first 100 free, then ₹1.50 + 18% GST', () => {
  // capacity → chargeable, base, GST, total (paise)
  for (const [cap, chargeable, base, gst, total] of [
    [100,   0,     0,       0,       0],
    [101,   1,     150,     27,      177],
    [500,   400,   60_000,  10_800,  70_800],
    [2_000, 1_900, 285_000, 51_300,  336_300],
  ] as const) {
    it(`${cap.toLocaleString('en-IN')} registrations → ${chargeable} chargeable, ₹${base / 100} + ₹${gst / 100} GST = ₹${total / 100}`, () => {
      const q = calculateActivationQuote({ capacity: cap, terms: T })
      expect(q.ok).toBe(true)
      if (!q.ok) return
      expect(q.quote).toMatchObject({ freeCapacity: 100, activationRatePaise: 150, chargeableCapacity: chargeable, basePaise: base, gstRatePercent: 18, gstPaise: gst, totalPaise: total })
      expect(q.quote.paymentRequired).toBe(total > 0)
    })
  }
  it('above the configured maximum is refused, never priced', () => {
    expect(calculateActivationQuote({ capacity: T.maximumEventCapacity + 1, terms: T }).ok).toBe(false)
  })
})

describe('Services — unit price × quantity + 18% GST', () => {
  it('WhatsApp ₹0.20: 2,000 → ₹400 + ₹72', () => {
    expect(priceServiceItem('whatsapp', 2_000, S.whatsapp)).toMatchObject({ unitPricePaise: 20, basePaise: 40_000, gstPaise: 7_200, totalPaise: 47_200 })
  })
  it('certificates ₹1.50: 500 → ₹750 + ₹135; one → ₹1.50 + ₹0.27', () => {
    expect(priceServiceItem('certificates', 500, S.certificates)).toMatchObject({ unitPricePaise: 150, basePaise: 75_000, gstPaise: 13_500, totalPaise: 88_500 })
    expect(priceServiceItem('certificates', 1, S.certificates)).toMatchObject({ basePaise: 150, gstPaise: 27, totalPaise: 177 })
  })
  it('photos ₹1.60: 1,000 → ₹1,600 + ₹288; the full 3,000 → ₹4,800 + ₹864', () => {
    expect(priceServiceItem('media', 1_000, S.media)).toMatchObject({ unitPricePaise: 160, basePaise: 160_000, gstPaise: 28_800, totalPaise: 188_800 })
    expect(priceServiceItem('media', MAX_EVENT_PHOTO_CAPACITY, S.media)).toMatchObject({ basePaise: 480_000, gstPaise: 86_400, totalPaise: 566_400 })
  })
  it('photos: max 3,000 per event — 3,000 allowed, 3,001 refused; a top-up cannot cross it either', () => {
    expect(MAX_EVENT_PHOTO_CAPACITY).toBe(3_000)
    expect(checkPhotoPurchase(0, 3_000)).toEqual({ ok: true })
    expect(checkPhotoPurchase(0, 3_001)).toMatchObject({ ok: false, code: 'PHOTO_CAPACITY_EXCEEDED', maxAdditional: 3_000 })
    expect(checkPhotoPurchase(2_500, 500)).toEqual({ ok: true })
    expect(checkPhotoPurchase(2_500, 501)).toMatchObject({ ok: false, maxAdditional: 500 })
  })
  it('no free photos: every photo is a paid unit (no allowance before the first purchase)', () => {
    expect(validateServiceQuantity('media', 0, S.media)).toEqual({ ok: true, quantity: 0 })
    expect(priceServiceItem('media', 1, S.media).totalPaise).toBeGreaterThan(0)
  })
  it('every priced line is self-consistent, so the purchase / ledger accepts it as stored', () => {
    for (const i of [priceServiceItem('whatsapp', 2_000, S.whatsapp), priceServiceItem('certificates', 500, S.certificates), priceServiceItem('media', 1_000, S.media)]) {
      expect(isConsistentServiceItem(i)).toBe(true)
    }
  })
})

describe('Public pricing calculator — the same functions, the same figures', () => {
  const sel = { registrations: 500, whatsapp: 2_000, certificates: 500, media: 1_000 }

  it('500 reg + 2,000 WhatsApp + 500 certificates + 1,000 photos = ₹3,350 + ₹603 GST = ₹3,953', () => {
    const e = estimateEventCost(publicConfig(), sel)
    expect(e.registrations.ok && e.registrations.quote.basePaise).toBe(60_000)
    const base = (k: 'whatsapp' | 'certificates' | 'media') => { const l = e.services[k]; return l.ok ? l.item?.basePaise : null }
    expect([base('whatsapp'), base('certificates'), base('media')]).toEqual([40_000, 75_000, 160_000])
    expect(e.totals).toEqual({ basePaise: 335_000, gstPaise: 60_300, totalPaise: 395_300 })
  })
  it('equals the License & Services pricing of the same selection, line for line', () => {
    const q = calculateActivationQuote({ capacity: 500, terms: T })
    const items = [priceServiceItem('whatsapp', 2_000, S.whatsapp), priceServiceItem('certificates', 500, S.certificates), priceServiceItem('media', 1_000, S.media)]
    const total = (q.ok ? q.quote.totalPaise : NaN) + items.reduce((n, i) => n + i.totalPaise, 0)
    expect(estimateEventCost(publicConfig(), sel).totals?.totalPaise).toBe(total)
  })
  it('over 3,000 photos is refused and shows no total', () => {
    const e = estimateEventCost(publicConfig(), { ...sel, media: 3_001 })
    expect(e.services.media).toMatchObject({ ok: false, code: 'PHOTO_CAPACITY_EXCEEDED' })
    expect(e.totals).toBeNull()
  })
  it('the ticket platform fee is NOT in the estimate: changing it changes nothing', () => {
    expect(estimateEventCost(publicConfig(50), sel).totals).toEqual(estimateEventCost(publicConfig(0), sel).totals)
    expect(T.attendeeTransactionFeePercent).toBe(0.5)                // the ticket fee default itself is untouched
  })
})

describe('Historical purchases stay frozen; refunds use the PAID line', () => {
  // A paid order from before RD-PRICE-01: 100 certificates at ₹1.90 (₹190 + ₹34.20).
  const oldLine: ServiceChargeItem = { service: 'certificates', quantity: 100, unitPricePaise: 190, basePaise: 19_000, gstRatePercent: 18, gstPaise: 3_420, totalPaise: 22_420, onExhausted: 'block' }
  const newLine = priceServiceItem('certificates', 100, S.certificates)
  const oldLot = { orderId: 'lic_old', at: 1, quantity: 100, totalPaise: oldLine.totalPaise }
  const newLot = { orderId: 'add_new', at: 2, quantity: 100, totalPaise: newLine.totalPaise }

  it('the stored historical line is still a valid, consistent line — nothing re-prices it', () => {
    expect(isConsistentServiceItem(oldLine)).toBe(true)
    expect(oldLine.totalPaise).toBe(22_420)
  })
  it('a NEW purchase of the same quantity uses the new price (₹150 + ₹27)', () => {
    expect(newLine).toMatchObject({ unitPricePaise: 150, basePaise: 15_000, gstPaise: 2_700, totalPaise: 17_700 })
  })
  it('40 unused units of the old purchase are worth 40/100 of what was PAID (₹89.68), not today’s ₹70.80', () => {
    expect(valueUnits([oldLot], 60, 0, 40)).toEqual({ valuePaise: 8_968, parts: [{ orderId: 'lic_old', units: 40, valuePaise: 8_968 }] })
  })
  it('old + new lots: the unused units are valued per line at each line’s own paid amount', () => {
    // 200 bought, 50 used from the oldest end → 150 unused: all 100 of the new line + 50 of the old.
    expect(valueUnits([oldLot, newLot], 50, 0, 150)).toEqual({
      valuePaise: 17_700 + 11_210,
      parts: [{ orderId: 'lic_old', units: 50, valuePaise: 11_210 }, { orderId: 'add_new', units: 100, valuePaise: 17_700 }],
    })
  })

  const state = (o: Partial<ServiceState> = {}): ServiceState => ({
    service: 'certificates', applicable: true, notApplicableReason: null, purchased: 100, used: 60, carriedIn: 0, carriedOut: 0, refunded: 0,
    remaining: 40, ownUnused: 40, paidPaise: 22_420, lots: [oldLot], usedFront: 60, removedBack: 0, problem: null, facts: {}, ...o,
  })
  const ctx = (o: Partial<EligibilityContext> = {}): EligibilityContext => ({
    lifecycle: 'completed', campaignType: null, openRequest: false, closedAtMs: 0, windowAt: 1, approvedPaise: 0, ...o,
  })

  it('refund = unused PAID units only, at the paid line amount', () => {
    expect(requestEligibility('refund', state(), ctx())).toMatchObject({ eligible: true, quantity: 40, upperBoundPaise: 8_968 })
  })
  it('carried-in units are never refundable: 500 carried in changes neither the quantity nor the amount', () => {
    expect(requestEligibility('refund', state({ carriedIn: 500, remaining: 540 }), ctx())).toMatchObject({ eligible: true, quantity: 40, upperBoundPaise: 8_968 })
  })
  it('the 24-hour window: inside is eligible, at/after the deadline is refused', () => {
    expect(requestEligibility('refund', state(), ctx({ windowAt: REFUND_WINDOW_MS - 1 }))).toMatchObject({ eligible: true })
    expect(requestEligibility('refund', state(), ctx({ windowAt: REFUND_WINDOW_MS }))).toMatchObject({ eligible: false, code: 'REFUND_WINDOW_CLOSED' })
  })
})
