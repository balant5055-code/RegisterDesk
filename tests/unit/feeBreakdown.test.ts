// RD-PAYMENT-02 Phase 1 — the canonical fee-breakdown projection is a lossless,
// model-correct view of the engine result. Pure; no Firebase, no I/O.

import { describe, it, expect } from 'vitest'
import { calculateFee } from '@/lib/fees/engine'
import { feeConfigFor } from '../fixtures/feeConfig'
import { toFeeBreakdownRecord, FINANCIAL_VERSION } from '@/lib/fees/feeBreakdown'

const GROSS = 100000  // ₹1000 ticket

describe('toFeeBreakdownRecord — canonical fee-breakdown projection', () => {
  it('organizer_pays: attendee charged the ticket only; organizer bears all fees', () => {
    const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: GROSS, feeModel: 'organizer_pays', config: feeConfigFor('starter') })
    const b = toFeeBreakdownRecord('organizer_pays', r)
    expect(b.financialVersion).toBe(FINANCIAL_VERSION)
    expect(b.feeModel).toBe('organizer_pays')
    expect(b.ticketBasePaise).toBe(GROSS)
    expect(b.chargeAmountPaise).toBe(GROSS)                 // no fee added on top
    expect(b.attendeeFeeTotalPaise).toBe(0)
    expect(b.organizerFeeTotalPaise).toBe(r.platformFeeTotalPaise + r.gatewayFeeEstimatePaise)
    expect(b.netSettlementPaise).toBe(r.netSettlementPaise)
    // universal invariant: charge = net + attendeeFees + organizerFees
    expect(b.chargeAmountPaise).toBe(b.netSettlementPaise + b.attendeeFeeTotalPaise + b.organizerFeeTotalPaise)
  })

  it('customer_pays: attendee charged ticket + fees; organizer receives the full ticket', () => {
    const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: GROSS, feeModel: 'customer_pays', config: feeConfigFor('starter') })
    const b = toFeeBreakdownRecord('customer_pays', r)
    expect(b.ticketBasePaise).toBe(GROSS)
    expect(b.chargeAmountPaise).toBe(GROSS + b.platformFeeTotalPaise + b.gatewayFeeEstimatePaise)
    expect(b.attendeeFeeTotalPaise).toBe(b.platformFeeTotalPaise + b.gatewayFeeEstimatePaise)
    expect(b.organizerFeeTotalPaise).toBe(0)
    expect(b.netSettlementPaise).toBe(GROSS)               // full ticket to organizer
    expect(b.chargeAmountPaise).toBe(b.netSettlementPaise + b.attendeeFeeTotalPaise + b.organizerFeeTotalPaise)
  })

  it('is a lossless field-for-field projection of the engine result', () => {
    const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: GROSS, feeModel: 'organizer_pays', config: feeConfigFor('pro') })
    const b = toFeeBreakdownRecord('organizer_pays', r)
    expect(b.platformFeeBasePaise).toBe(r.platformFeeBasePaise)
    expect(b.platformFeeGstPaise).toBe(r.platformFeeGstPaise)
    expect(b.platformFeeTotalPaise).toBe(r.platformFeeTotalPaise)
    expect(b.gatewayFeeEstimatePaise).toBe(r.gatewayFeeEstimatePaise)
  })
})
