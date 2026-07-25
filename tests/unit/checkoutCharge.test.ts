// RD-PAYMENT-02 Phase 4 — the feature-gated canonical checkout charge. Pure; no Firebase.
// Proves: flag OFF is byte-identical (ticket only, no breakdown); flag ON keeps
// organizer_pays charging the ticket; customer_pays charges ticket + fees.

import { describe, it, expect } from 'vitest'
import { resolveCheckoutCharge } from '@/lib/fees/checkoutCharge'

const FEE_CONFIG = {
  platformFeePercentBps: 200, platformFeeFixedPaise: 0, platformFeeMinPaise: 0,
  platformFeeMaxPaise: 0, gatewayFeePercentBps: 200, gatewayFeeFixedPaise: 0, gstRatePercent: 18,
}
const TICKET = 50000  // ₹500 in paise

describe('resolveCheckoutCharge — feature-gated canonical checkout charge', () => {
  it('gate OFF: charges the ticket unchanged, no breakdown (byte-identical to today)', () => {
    const c = resolveCheckoutCharge({ pricingEngineEnabled: false, finalAmountPaise: TICKET, eventFeeModel: 'customer_pays', feeConfig: FEE_CONFIG })
    expect(c.amountPaise).toBe(TICKET)     // a customer_pays candidate is ignored while dormant
    expect(c.financials).toBeUndefined()
    expect(c.feeModel).toBe('organizer_pays')
  })

  it('gate ON but no feeConfig: still charges the ticket unchanged (defensive)', () => {
    const c = resolveCheckoutCharge({ pricingEngineEnabled: true, finalAmountPaise: TICKET, eventFeeModel: 'customer_pays' })
    expect(c.amountPaise).toBe(TICKET)
    expect(c.financials).toBeUndefined()
  })

  it('gate ON + organizer_pays: charges the ticket; persists breakdown with 0 attendee fees', () => {
    const c = resolveCheckoutCharge({ pricingEngineEnabled: true, finalAmountPaise: TICKET, eventFeeModel: 'organizer_pays', feeConfig: FEE_CONFIG })
    expect(c.amountPaise).toBe(TICKET)     // organizer_pays → charge === ticket (unchanged)
    expect(c.feeModel).toBe('organizer_pays')
    expect(c.financials).toBeDefined()
    expect(c.financials!.chargeAmountPaise).toBe(TICKET)
    expect(c.financials!.ticketBasePaise).toBe(TICKET)
    expect(c.financials!.attendeeFeeTotalPaise).toBe(0)
  })

  it('gate ON + customer_pays: charges ticket + fees; organizer receives the full ticket', () => {
    const c = resolveCheckoutCharge({ pricingEngineEnabled: true, finalAmountPaise: TICKET, eventFeeModel: 'customer_pays', feeConfig: FEE_CONFIG })
    expect(c.feeModel).toBe('customer_pays')
    expect(c.financials).toBeDefined()
    const platformTotal = c.financials!.platformFeeTotalPaise
    const gateway = c.financials!.gatewayFeeEstimatePaise
    expect(c.amountPaise).toBe(TICKET + platformTotal + gateway)   // ticket + fees
    expect(c.financials!.chargeAmountPaise).toBe(c.amountPaise)
    expect(c.financials!.netSettlementPaise).toBe(TICKET)          // organizer gets the full ticket
    expect(c.financials!.attendeeFeeTotalPaise).toBe(platformTotal + gateway)
  })

  it('defaults a null event fee model to organizer_pays when the engine is on', () => {
    const c = resolveCheckoutCharge({ pricingEngineEnabled: true, finalAmountPaise: TICKET, eventFeeModel: null, feeConfig: FEE_CONFIG })
    expect(c.feeModel).toBe('organizer_pays')
    expect(c.amountPaise).toBe(TICKET)
  })
})
