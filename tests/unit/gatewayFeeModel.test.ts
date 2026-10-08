// Payment-gateway fee model audit — how the Razorpay charge is represented TODAY (RD-FEE-03 audit).
//
// Characterisation tests over the real code (only Business Configuration and Firestore stubbed):
//
//   ESTIMATE  fees.gatewayFeePercent (default 2%, Super Admin editable) → resolveFeeConfig →
//             calculateFee: gatewayFeeEstimatePaise = round(gross × %), NO GST on it. It is frozen
//             into the ledger row's netSettlementPaise when the registration is recorded, and
//             that net is what the organizer's wallet is credited with and what is released.
//   ACTUAL    the payment.captured webhook carries Razorpay's `fee` and `tax` (TAX-INCLUSIVE: `tax`
//             is the GST inside `fee`). It is stored write-once as gatewayFeeActualPaise /
//             gatewayTaxPaise on the ledger row and used by Finance REPORTING (basis 'actual').
//             It does NOT re-price netSettlementPaise — there is no true-up.
//
// Invariants pinned: the gateway charge is never part of the RegisterDesk platform fee or its
// revenue; it is deducted from the organizer exactly once; the actual figure is never added to
// its own tax; historical frozen rows keep their stored figures.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_COMMERCIAL_TERMS } from '@/lib/licensing/capacityCommercial'
import { calculateFee } from '@/lib/fees/engine'
import { computeReconciledFees, DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { extractActualGatewayFee } from '@/lib/payments/actualGatewayFee'
import { resolveGatewayFee } from '@/lib/finance/gatewayFee'
import type { FeeConfig } from '@/lib/fees/types'

vi.setConfig({ testTimeout: 60_000 })

const state: { fees: Record<string, unknown> } = { fees: {} }
vi.mock('@/lib/config/businessConfigService', async () => {
  const { BUSINESS_CONFIG_DEFAULTS } = await import('@/lib/config/businessConfig')
  return { businessConfig: {
    getStoredLayer: async () => ({ stored: {}, loadFailed: false }),
    getSection: async (key: string) =>
      key === 'fees' ? { ...BUSINESS_CONFIG_DEFAULTS.fees, ...state.fees }
      : key === 'licensing' ? { ...BUSINESS_CONFIG_DEFAULTS.licensing, commercial: { ...DEFAULT_COMMERCIAL_TERMS } }
      : (BUSINESS_CONFIG_DEFAULTS as Record<string, unknown>)[key],
  } }
})
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ uid: 'org-1' }) }) }) }) },
}))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => {}, captureFinancialError: () => {} }))

beforeEach(() => { vi.resetModules(); state.fees = {} })

async function checkoutFeeConfig(): Promise<FeeConfig> {
  const { resolveEventFeeConfig } = await import('@/lib/fees/resolveEventFeeConfig')
  const r = await resolveEventFeeConfig('any-event')
  if (!r.ok) throw new Error(r.reason)
  return r.config
}
async function ledgerFor(config: FeeConfig, grossAmountPaise: number) {
  const { buildRegistrationLedgerAndCredit } = await import('@/lib/payments/registrationLedger')
  const feeInputs = { version: 1, planTier: 'starter', feeConfigId: 'plan:starter', capturedAt: '2026-10-07T00:00:00Z', feeConfig: config }
  return buildRegistrationLedgerAndCredit({ registrationId: 'r', organizerUid: 'org-1', eventSlug: 'e', attendeeName: 'A', attendeeEmail: 'a@x.test',
    grossAmountPaise, paymentId: 'p', orderId: 'o', feeInputs } as never)
}

describe('1 · the gateway ESTIMATE: 2% of the ticket (fees.gatewayFeePercent), no GST, separate from the platform fee', () => {
  // ticket ₹ → platform 0.5% ₹, platform GST ₹, gateway estimate ₹, organizer net ₹
  for (const [t, pf, pg, gw, net] of [
    [100, 0.5, 0.09, 2, 97.41], [500, 2.5, 0.45, 10, 487.05], [1_000, 5, 0.9, 20, 974.1], [5_000, 25, 4.5, 100, 4_870.5],
  ] as const) {
    it(`₹${t}: platform ₹${pf} + GST ₹${pg}; gateway estimate ₹${gw}; organizer net ₹${net} — ledger and wallet credit agree`, async () => {
      const c = await checkoutFeeConfig()
      expect(c.gatewayFeePercentBps).toBe(200)
      expect(c.gatewayFeeFixedPaise).toBe(0)
      const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: t * 100, feeModel: 'organizer_pays', config: c })
      expect(r.platformFeeBasePaise / 100).toBe(pf)
      expect(r.platformFeeGstPaise / 100).toBe(pg)
      expect(r.gatewayFeeEstimatePaise / 100).toBe(gw)
      expect(r.netSettlementPaise / 100).toBe(net)
      // the platform fee total never contains the gateway charge
      expect(r.platformFeeTotalPaise).toBe(r.platformFeeBasePaise + r.platformFeeGstPaise)

      const { ledger, credit } = await ledgerFor(c, t * 100)
      expect(ledger.gatewayFeeEstimatePaise).toBe(r.gatewayFeeEstimatePaise)
      expect(ledger.netSettlementPaise).toBe(r.netSettlementPaise)
      // deducted exactly ONCE: gross = net + platform total + gateway estimate
      expect(ledger.grossAmountPaise).toBe(ledger.netSettlementPaise + ledger.platformFeeTotalPaise + ledger.gatewayFeeEstimatePaise)
      expect(credit.netSettlementPaise).toBe(ledger.netSettlementPaise)
      expect(credit.feesTotalPaise).toBe(ledger.platformFeeTotalPaise + ledger.gatewayFeeEstimatePaise)
    })
  }

  it('platform fee OFF: the organizer bears only the gateway estimate (no platform fee, no platform GST)', async () => {
    state.fees = { platformFeeEnabled: false }
    const { ledger } = await ledgerFor(await checkoutFeeConfig(), 100_000)
    expect(ledger.platformFeeTotalPaise).toBe(0)
    expect(ledger.gatewayFeeEstimatePaise).toBe(2_000)
    expect(ledger.netSettlementPaise).toBe(98_000)
  })

  it('the estimate is configuration: fees.gatewayFeePercent / gatewayFeeEnabled move it, never the platform fee', async () => {
    state.fees = { gatewayFeePercent: 2.36 }
    const a = await ledgerFor(await checkoutFeeConfig(), 100_000)
    expect(a.ledger.gatewayFeeEstimatePaise).toBe(2_360)
    expect(a.ledger.platformFeeBasePaise).toBe(500)
    vi.resetModules(); state.fees = { gatewayFeeEnabled: false }
    const b = await ledgerFor(await checkoutFeeConfig(), 100_000)
    expect(b.ledger.gatewayFeeEstimatePaise).toBe(0)
    expect(b.ledger.platformFeeBasePaise).toBe(500)
  })

  it('the gateway estimate is never RegisterDesk revenue (pricing-snapshot path)', async () => {
    const c = await checkoutFeeConfig()
    const s = computeReconciledFees(100_000, c, DEFAULT_COMMERCIAL_MODEL)
    expect(s.platformRevenuePaise).toBe(s.platformFeeBasePaise)        // 0.5% only
    expect(s.gatewayFeeGstPaise).toBe(0)                               // production model: no gateway GST
    expect(s.gatewayFeeTotalPaise).toBe(2_000)
  })
})

describe('2 · the gateway ACTUAL: Razorpay fee + tax, tax-INCLUSIVE, reporting only', () => {
  it('is read from the payment entity; tax is a component of fee, never added to it', () => {
    expect(extractActualGatewayFee({ fee: 2_360, tax: 360 })).toEqual({ gatewayFeeActualPaise: 2_360, gatewayTaxPaise: 360 })
    expect(extractActualGatewayFee({ fee: null, tax: null })).toBeNull()              // authorized, not captured
    expect(extractActualGatewayFee({ fee: 100, tax: 500 })).toBeNull()               // tax > fee: refused
  })

  it('Finance shows the actual once present — and the organizer NET is NOT re-priced (no true-up, no double deduction)', async () => {
    const { ledger } = await ledgerFor(await checkoutFeeConfig(), 100_000)
    const { readFinanceFromLedger } = await import('@/lib/platform/pricing')
    const { buildFinanceTransactionView } = await import('@/lib/finance/financeService')
    const before = buildFinanceTransactionView(ledger as never, readFinanceFromLedger(ledger as never), null)
    expect(before.gatewayFeeBasis).toBe('estimated')
    expect(before.gatewayFeePaise).toBe(2_000)
    const withActual = { ...ledger, gatewayFeeActualPaise: 1_950, gatewayTaxPaise: 297 }
    const after = buildFinanceTransactionView(withActual as never, readFinanceFromLedger(withActual as never), null)
    expect(after.gatewayFeeBasis).toBe('actual')
    expect(after.gatewayFeePaise).toBe(1_950)                            // the actual REPLACES the estimate in reporting
    expect(after.organizerNetPaise).toBe(before.organizerNetPaise)       // payable still gross − platform − ESTIMATE
    expect(after.organizerNetPaise).toBe(100_000 - 590 - 2_000)
  })

  it('workspace totals blend actual + estimate per row and keep tax inside the fee', () => {
    const r = resolveGatewayFee({ total: 3, estimateAll: 6_000, covered: { count: 2, sums: { gatewayFeeActualPaise: 3_900, gatewayTaxPaise: 594, gatewayFeeEstimatePaise: 4_000 } } as never })
    expect(r.basis).toBe('mixed')
    expect(r.fee).toEqual({ ok: true, paise: 3_900 + 2_000 })            // two actuals + one remaining estimate
    expect(r.tax).toEqual({ ok: true, paise: 594 })                      // reported, NOT added to the fee
  })
})

describe('3 · historical frozen rows keep their stored figures', () => {
  it('a row recorded under an older config (2% + ₹5 platform, 2% gateway) reads back exactly as stored', async () => {
    const legacy = { version: 1, planTier: 'starter', feeConfigId: 'plan:starter', capturedAt: '2026-09-30T00:00:00Z', feeConfig: {
      platformFeePercentBps: 200, platformFeeFixedPaise: 500, platformFeeMinPaise: 500, platformFeeMaxPaise: 0,
      gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18 } }
    const { buildRegistrationLedgerAndCredit } = await import('@/lib/payments/registrationLedger')
    const { ledger } = await buildRegistrationLedgerAndCredit({ registrationId: 'h', organizerUid: 'org-1', eventSlug: 'e', attendeeName: 'A', attendeeEmail: 'a@x.test',
      grossAmountPaise: 50_000, paymentId: 'p', orderId: 'o', feeInputs: legacy } as never)
    expect([ledger.platformFeeBasePaise, ledger.gatewayFeeEstimatePaise, ledger.netSettlementPaise]).toEqual([1_500, 1_000, 50_000 - 1_770 - 1_000])
    const { readFinanceFromLedger } = await import('@/lib/platform/pricing')
    const fig = readFinanceFromLedger(ledger as never)
    expect([fig.platformFeeBasePaise, fig.gatewayFeeEstimatePaise, fig.netSettlementPaise]).toEqual([1_500, 1_000, ledger.netSettlementPaise])
  })
})
