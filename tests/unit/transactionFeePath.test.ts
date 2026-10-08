// Paid-ticket fee path — RD-FEE-01 / RD-FEE-02.
//
// Business rule (owner, 2026-10-07): a paid ticket carries TWO SEPARATE charges.
//   A. the REGISTERDESK PLATFORM FEE — ticket price × the configured percentage (default 0.5%,
//      Super Admin editable), plus GST on that fee. No fixed part, no minimum, no cap.
//      Platform fee OFF ⇒ ₹0 platform fee and ₹0 GST on it.
//   B. the PAYMENT GATEWAY charge — the payment provider's, never RegisterDesk's; separate.
// Attendee-pays is OFF: the attendee is charged the ticket price only.
//
// Exercises the real code end to end, with only Business Configuration and the event read stubbed:
//   checkout       resolveEventFeeConfig → getFeePlanForOrganizer ('starter') → resolveFeeConfig
//   attendee pays  resolveCheckoutCharge (engine OFF ⇒ the ticket price)
//   ledger         buildRegistrationLedgerAndCredit (what is recorded and settled), via calculateFee
//   shadow path    computeReconciledFees (pricing snapshot) over the same FeeConfig
//   builder        computeFeePreview with the builder's own rate mapping
//   public page    getPublicPricing().ticketFee → formatTicketFee

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_COMMERCIAL_TERMS, type CommercialTerms } from '@/lib/licensing/capacityCommercial'
import { calculateFee } from '@/lib/fees/engine'
import { resolveCheckoutCharge } from '@/lib/fees/checkoutCharge'
import { computeReconciledFees, DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { formatTicketFee, hasTicketFee, NO_PLATFORM_FEE } from '@/lib/licensing/publicPricing'
import { getDefaultFeeConfig } from '@/lib/fees/config'
import { FAQ_ITEMS } from '@/content/marketing/faq'
import type { FeeConfig } from '@/lib/fees/types'

vi.setConfig({ testTimeout: 60_000 })

const state: { fees: Record<string, unknown>; commercial?: Partial<CommercialTerms>; event: 'ok' | 'throw'; loadFailed: boolean } =
  { fees: {}, event: 'ok', loadFailed: false }

vi.mock('@/lib/config/businessConfigService', async () => {
  const { BUSINESS_CONFIG_DEFAULTS } = await import('@/lib/config/businessConfig')
  return { businessConfig: {
    getStoredLayer: async () => ({ stored: state.commercial ? { licensing: { commercial: state.commercial } } : {}, loadFailed: state.loadFailed }),
    getSection: async (key: string) =>
      key === 'fees' ? { ...BUSINESS_CONFIG_DEFAULTS.fees, ...state.fees }
      : key === 'licensing' ? { ...BUSINESS_CONFIG_DEFAULTS.licensing, commercial: { ...DEFAULT_COMMERCIAL_TERMS, ...(state.commercial ?? {}) } }
      : (BUSINESS_CONFIG_DEFAULTS as Record<string, unknown>)[key],
  } }
})
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => {
    if (state.event === 'throw') throw new Error('simulated Firestore outage')
    return { exists: true, data: () => ({ uid: 'org-1' }) }
  } }) }) },
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {}, captureFinancialError: () => {} }))

beforeEach(() => { vi.resetModules(); state.fees = {}; state.commercial = undefined; state.event = 'ok'; state.loadFailed = false })

/** The fee configuration checkout freezes onto a new ticket sale. */
async function checkoutFeeConfig(): Promise<FeeConfig> {
  const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
  const r = await resolveEventFeeConfig('any-event')
  if (!r.ok) throw new Error(`checkout refused: ${r.reason}`)
  expect(r.planTier).toBe('starter')
  return r.config
}
const organizerSide = (config: FeeConfig, grossAmountPaise: number) =>
  calculateFee({ transactionType: 'event_registration', grossAmountPaise, feeModel: 'organizer_pays', config })
const rupees = (paise: number) => paise / 100

describe('1 · the default RegisterDesk platform fee is 0.5% + GST — no fixed part, no minimum', () => {
  it('the authoritative default (licensing.commercial) is 0.5%; checkout resolves 50 bps, ₹0 fixed, ₹0 minimum, uncapped', async () => {
    expect(DEFAULT_COMMERCIAL_TERMS.attendeeTransactionFeePercent).toBe(0.5)
    const c = await checkoutFeeConfig()
    expect(c).toEqual({
      platformFeePercentBps: 50, platformFeeFixedPaise: 0, platformFeeMinPaise: 0, platformFeeMaxPaise: 0,
      gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18,
    })
  })

  // ticket ₹ → expected platform fee ₹ and GST ₹ (18%)
  for (const [ticket, fee, gst] of [[100, 0.5, 0.09], [500, 2.5, 0.45], [1_000, 5, 0.9], [5_000, 25, 4.5]] as const) {
    it(`a ₹${ticket} ticket → platform fee ₹${fee} + GST ₹${gst}; the attendee pays ₹${ticket}`, async () => {
      const c = await checkoutFeeConfig()
      expect(resolveCheckoutCharge({ pricingEngineEnabled: false, finalAmountPaise: ticket * 100, eventFeeModel: null }).amountPaise).toBe(ticket * 100)
      const r = organizerSide(c, ticket * 100)
      expect(r.chargeAmountPaise).toBe(ticket * 100)
      expect(rupees(r.platformFeeBasePaise)).toBe(fee)
      expect(rupees(r.platformFeeGstPaise)).toBe(gst)
    })
  }

  it('no ₹5 fixed part and no ₹5 minimum: a ₹10 ticket pays ₹0.05; a free (₹0) ticket pays nothing', async () => {
    const c = await checkoutFeeConfig()
    expect(organizerSide(c, 1_000).platformFeeBasePaise).toBe(5)
    expect(organizerSide(c, 0).platformFeeTotalPaise).toBe(0)
  })
})

describe('2 · the percentage is configuration, not code', () => {
  it('a 1% configuration → a ₹1,000 ticket pays ₹10 platform fee (licensing.commercial)', async () => {
    state.commercial = { attendeeTransactionFeePercent: 1 }
    expect(rupees(organizerSide(await checkoutFeeConfig(), 100_000).platformFeeBasePaise)).toBe(10)
  })
  it('an explicit fees.platformFeePercent override still wins (this is how production is at 1% today)', async () => {
    state.fees = { platformFeePercent: 1 }
    expect((await checkoutFeeConfig()).platformFeePercentBps).toBe(100)
  })
})

describe('3 · GST is on the platform fee only; the gateway charge is separate', () => {
  it('GST follows fees.gstPercent; switching GST off zeroes it', async () => {
    state.fees = { gstPercent: 12 }
    expect(organizerSide(await checkoutFeeConfig(), 100_000).platformFeeGstPaise).toBe(60)
    vi.resetModules(); state.fees = { gstEnabled: false }
    expect(organizerSide(await checkoutFeeConfig(), 100_000).platformFeeGstPaise).toBe(0)
  })
  it('the gateway estimate is a different line: it does not change the platform fee, nor is it part of it', async () => {
    const on = organizerSide(await checkoutFeeConfig(), 100_000)
    vi.resetModules(); state.fees = { gatewayFeeEnabled: false }
    const off = organizerSide(await checkoutFeeConfig(), 100_000)
    expect(on.gatewayFeeEstimatePaise).toBe(2_000)
    expect(off.gatewayFeeEstimatePaise).toBe(0)
    expect(off.platformFeeBasePaise).toBe(on.platformFeeBasePaise)
  })
})

describe('4 · platform fee OFF ⇒ ₹0 platform fee and ₹0 GST on it', () => {
  it('for every ticket price', async () => {
    state.fees = { platformFeeEnabled: false }
    const c = await checkoutFeeConfig()
    expect([c.platformFeePercentBps, c.platformFeeFixedPaise, c.platformFeeMinPaise]).toEqual([0, 0, 0])
    for (const gross of [100, 10_000, 100_000, 500_000]) {
      const r = organizerSide(c, gross)
      expect([r.platformFeeBasePaise, r.platformFeeGstPaise, r.platformFeeTotalPaise], `@${gross}`).toEqual([0, 0, 0])
    }
  })
})

describe('5 · checkout snapshot, ledger, snapshot path and builder preview all agree', () => {
  it('the ledger records exactly the checkout fee (frozen feeInputs), and a later config change does not re-price it', async () => {
    const c = await checkoutFeeConfig()
    const feeInputs = { version: 1, planTier: 'starter', feeConfigId: 'plan:starter', capturedAt: '2026-10-07T00:00:00Z', feeConfig: c }
    const { buildRegistrationLedgerAndCredit } = await import('@/lib/payments/registrationLedger')
    const src = { registrationId: 'r', organizerUid: 'org-1', eventSlug: 'e', attendeeName: 'A', attendeeEmail: 'a@x.test', grossAmountPaise: 100_000, paymentId: 'p', orderId: 'o', feeInputs }
    const led = await buildRegistrationLedgerAndCredit(src as never)
    expect(led.ledger.platformFeeBasePaise).toBe(500)
    expect(led.ledger.platformFeeGstPaise).toBe(90)
    state.fees = { platformFeePercent: 3 }                      // a later Super Admin change
    const again = await buildRegistrationLedgerAndCredit(src as never)
    expect(again.ledger.platformFeeBasePaise).toBe(500)        // the frozen terms, not 3%
  })

  it('HISTORICAL snapshots are untouched: a frozen ₹5-fixed 2% snapshot still settles as it was charged', async () => {
    const legacy = { version: 1, planTier: 'starter', feeConfigId: 'plan:starter', capturedAt: '2026-09-30T00:00:00Z', feeConfig: {
      platformFeePercentBps: 200, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise: 0,
      gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 } }
    const { buildRegistrationLedgerAndCredit } = await import('@/lib/payments/registrationLedger')
    const led = await buildRegistrationLedgerAndCredit({ registrationId: 'h', organizerUid: 'org-1', eventSlug: 'e', attendeeName: 'A', attendeeEmail: 'a@x.test', grossAmountPaise: 50_000, paymentId: 'p', orderId: 'o', feeInputs: legacy } as never)
    expect(led.ledger.platformFeeBasePaise).toBe(1_500)       // 2% of ₹500 + ₹5 — exactly as frozen
    expect(getDefaultFeeConfig('event_registration', 'starter').platformFeeFixedPaise).toBe(500)   // the table row is not edited
  })

  it('the pricing-snapshot path equals the ledger', async () => {
    for (const fees of [{}, { platformFeeEnabled: false }, { gstPercent: 12 }, { platformFeePercent: 1 }]) {
      vi.resetModules(); state.fees = fees
      const c = await checkoutFeeConfig()
      for (const gross of [10_000, 49_900, 100_000, 500_000]) {
        const ledger = organizerSide(c, gross)
        const shadow = computeReconciledFees(gross, c, DEFAULT_COMMERCIAL_MODEL)
        expect(shadow.platformFeeBasePaise, JSON.stringify(fees)).toBe(ledger.platformFeeBasePaise)
        expect(shadow.platformFeeGstPaise).toBe(ledger.platformFeeGstPaise)
      }
    }
  })

  it('the event-builder preview shows the same platform fee, GST and net as the ledger', async () => {
    for (const fees of [{}, { platformFeeEnabled: false }, { gstPercent: 12 }, { platformFeePercent: 1 }]) {
      vi.resetModules(); state.fees = fees
      const { computeFeePreview } = await import('@/lib/events/builder/feePreview')
      const pub = await (await import('@/lib/fees/resolvePublicFeesConfig')).getPublicFeesConfig()
      const rates = {   // exactly the builder page's feeRatesFrom
        platformPercent: pub.platformFeePercent,
        gatewayPercent:  pub.gatewayFeeEnabled ? pub.gatewayFeePercent : 0,
        gstPercent:      pub.gstEnabled ? pub.gstPercent : 0,
      }
      const ledger = organizerSide(await checkoutFeeConfig(), 100_000)
      const preview = computeFeePreview(1_000, 'organizer_absorbs', rates)
      const tag = JSON.stringify(fees)
      expect(preview.platformFee, tag).toBe(rupees(ledger.platformFeeBasePaise))
      expect(preview.gstOnFees, tag).toBe(rupees(ledger.platformFeeGstPaise))
      expect(preview.organizerGets, tag).toBe(rupees(ledger.netSettlementPaise))
      if (!fees.platformFeeEnabled && Object.keys(fees).length === 0) expect(pub.platformFeePercent).toBe(0.5)
    }
  })
})

describe('6 · /pricing states exactly what checkout resolves, as the RegisterDesk platform fee', () => {
  for (const [name, fees, commercial] of [
    ['defaults', {}, undefined],
    ['a 1% configuration', {}, { attendeeTransactionFeePercent: 1 }],
    ['an admin platformFeePercent override', { platformFeePercent: 4, gstPercent: 12 }, undefined],
    ['the platform fee switched off', { platformFeeEnabled: false }, undefined],
  ] as const) {
    it(`${name}`, async () => {
      state.fees = { ...fees }; state.commercial = commercial
      const c = await checkoutFeeConfig()
      const { getPublicPricing } = await import('@/lib/licensing/publicPricingServer')
      const p = await getPublicPricing()
      expect(p!.ticketFee).toEqual({
        percent: c.platformFeePercentBps / 100, fixedPaise: c.platformFeeFixedPaise, minPaise: c.platformFeeMinPaise,
        maxPaise: c.platformFeeMaxPaise, gstRatePercent: c.gstRatePercent,
      })
      expect(p!.ticketFee).not.toHaveProperty('gatewayFeePercentBps')
      expect(formatTicketFee(p!.ticketFee)).not.toMatch(/₹|transaction fee/i)
    })
  }
  it('the wording: default, and switched off', async () => {
    const { getPublicPricing } = await import('@/lib/licensing/publicPricingServer')
    const on = (await getPublicPricing())!.ticketFee
    expect(formatTicketFee(on)).toBe('0.5% on paid ticket sales + GST')
    expect(hasTicketFee(on)).toBe(true)
    vi.resetModules(); state.fees = { platformFeeEnabled: false }
    const off = (await (await import('@/lib/licensing/publicPricingServer')).getPublicPricing())!.ticketFee
    expect(formatTicketFee(off)).toBe(NO_PLATFORM_FEE)
    expect(NO_PLATFORM_FEE).toBe('No RegisterDesk platform fee')
    expect(hasTicketFee(off)).toBe(false)
  })
})

describe('7 · the FAQ separates the two charges and names no figure', () => {
  it('RegisterDesk platform fee + GST; gateway charged by the payment provider; figures on /pricing', () => {
    const item = FAQ_ITEMS.find(i => i.id === 'transaction-fees')!
    expect(item.answer).not.toMatch(/\d|₹|%/)
    expect(item.answer).toMatch(/RegisterDesk platform fee/)
    expect(item.answer).toMatch(/charged by the payment provider, not RegisterDesk/)
    expect(item.href).toBe('/pricing')
  })
})

describe('8 · invalid / unavailable configuration fails safely', () => {
  it('/pricing publishes nothing when the configuration cannot be read', async () => {
    state.loadFailed = true
    const { getPublicPricing } = await import('@/lib/licensing/publicPricingServer')
    expect(await getPublicPricing()).toBeNull()
  })
  it('checkout refuses when the event cannot be read — never a silent global fall-back', async () => {
    state.event = 'throw'
    const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
    expect(await resolveEventFeeConfig('any-event')).toEqual({ ok: false, reason: 'EVENT_READ_FAILED' })
  })
  it('an unusable stored percentage does not price at 0 — the resolver falls back to the canonical row', async () => {
    state.commercial = { attendeeTransactionFeePercent: Number.NaN }
    expect((await checkoutFeeConfig()).platformFeePercentBps).toBeGreaterThan(0)
  })
})
