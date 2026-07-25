// RD-PAYMENT-02 Phase 6 — the ONE canonical finance reader (financeSnapshot) is now
// financials-aware: prefer the persisted breakdown when present; fall back transparently
// to the flat ledger fields (byte-identical) for legacy records. Pure; no Firebase.

import { describe, it, expect } from 'vitest'
import { readReportFromLedger, readReportFromLedgerData } from '@/lib/platform/pricing/financeSnapshot'

const FLAT = {
  grossAmountPaise: 100000, platformFeeBasePaise: 2000, platformFeeGstPaise: 360,
  platformFeeTotalPaise: 2360, gatewayFeeEstimatePaise: 2000, netSettlementPaise: 95640,
}
const FINANCIALS = {
  financialVersion: 1, feeModel: 'organizer_pays' as const,
  ticketBasePaise: 100000, chargeAmountPaise: 100000,
  platformFeeBasePaise: 2000, platformFeeGstPaise: 360, platformFeeTotalPaise: 2360,
  gatewayFeeEstimatePaise: 2000, attendeeFeeTotalPaise: 0, organizerFeeTotalPaise: 4360,
  netSettlementPaise: 95640,
}

describe('financeSnapshot canonical reader — Phase 6 financials-awareness', () => {
  it('legacy (no financials, no snapshot): reads flat fields, source=fallback (byte-identical)', () => {
    const fig = readReportFromLedger({ ...FLAT })
    expect(fig.source).toBe('fallback')
    expect(fig.grossAmountPaise).toBe(100000)
    expect(fig.netSettlementPaise).toBe(95640)
    expect(fig.feeModel).toBeUndefined()        // additive fields absent for legacy
    expect(fig.chargeAmountPaise).toBeUndefined()
  })

  it('prefers financials when present: source=financials, core figures identical + richer fields', () => {
    const fig = readReportFromLedger({ ...FLAT, financials: FINANCIALS })
    expect(fig.source).toBe('financials')
    expect(fig.grossAmountPaise).toBe(100000)   // core figures byte-identical to the flat ledger
    expect(fig.platformFeeTotalPaise).toBe(2360)
    expect(fig.gatewayFeeEstimatePaise).toBe(2000)
    expect(fig.netSettlementPaise).toBe(95640)
    expect(fig.feeModel).toBe('organizer_pays') // richer canonical fields now available
    expect(fig.chargeAmountPaise).toBe(100000)
    expect(fig.attendeeFeeTotalPaise).toBe(0)
    expect(fig.financialVersion).toBe(1)
  })

  it('untyped reader coerces + prefers a valid financials object', () => {
    const fig = readReportFromLedgerData({ ...FLAT, financials: FINANCIALS })
    expect(fig.source).toBe('financials')
    expect(fig.feeModel).toBe('organizer_pays')
  })

  it('untyped reader ignores a malformed financials and falls back to flat', () => {
    const fig = readReportFromLedgerData({ ...FLAT, financials: { feeModel: 'organizer_pays' } })
    expect(fig.source).toBe('fallback')
    expect(fig.grossAmountPaise).toBe(100000)
    expect(fig.feeModel).toBeUndefined()
  })

  it('customer_pays financials: organizer nets the full ticket; attendee bore the fees', () => {
    const cp = { ...FINANCIALS, feeModel: 'customer_pays' as const, chargeAmountPaise: 104360, netSettlementPaise: 100000, attendeeFeeTotalPaise: 4360, organizerFeeTotalPaise: 0 }
    const fig = readReportFromLedger({ ...FLAT, netSettlementPaise: 100000, financials: cp })
    expect(fig.source).toBe('financials')
    expect(fig.feeModel).toBe('customer_pays')
    expect(fig.netSettlementPaise).toBe(100000)  // organizer receives the full ticket
    expect(fig.chargeAmountPaise).toBe(104360)   // attendee paid ticket + fees
    expect(fig.attendeeFeeTotalPaise).toBe(4360)
  })
})
