// RD-GA-HARDEN-01 — reconciled commercial engine (commercial.ts) + units.

import { describe, it, expect } from 'vitest'
import { computeReconciledFees, commercialToFeeModel, DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { calculateFee } from '@/lib/fees/engine'
import { rupeesToPaise, paiseToRupees, PAISE_PER_RUPEE } from '@/lib/platform/pricing/units'
import { feeConfigFor } from '../fixtures/feeConfig'

describe('computeReconciledFees — default mirrors production organizer_pays', () => {
  it('matches calculateFee(organizer_pays) field-for-field', () => {
    const cfg = feeConfigFor('starter')
    const eng = computeReconciledFees(100000, cfg, DEFAULT_COMMERCIAL_MODEL, 0)
    const prod = calculateFee({ transactionType: 'event_registration', grossAmountPaise: 100000, feeModel: 'organizer_pays', config: cfg })
    expect(eng.platformFeeBasePaise).toBe(prod.platformFeeBasePaise)
    expect(eng.platformFeeGstPaise).toBe(prod.platformFeeGstPaise)
    expect(eng.gatewayFeeBasePaise).toBe(prod.gatewayFeeEstimatePaise)
    expect(eng.chargeAmountPaise).toBe(prod.chargeAmountPaise)     // == gross
    expect(eng.netSettlementPaise).toBe(prod.netSettlementPaise)
  })
})

describe('computeReconciledFees — configurable axes', () => {
  const cfg = feeConfigFor('starter')

  it('attendee-pays model adds fees on top; organizer nets gross', () => {
    const fees = computeReconciledFees(100000, cfg, {
      platformFeePaidBy: 'attendee', gatewayFeePaidBy: 'attendee',
      platformGstEnabled: true, gatewayGstEnabled: false, convenienceFeeEnabled: false,
    }, 0)
    expect(fees.netSettlementPaise).toBe(100000)
    expect(fees.chargeAmountPaise).toBe(100000 + fees.platformFeeTotalPaise + fees.gatewayFeeTotalPaise)
  })

  it('gateway GST toggle adds 18% on the gateway fee', () => {
    const on  = computeReconciledFees(100000, cfg, { ...DEFAULT_COMMERCIAL_MODEL, gatewayGstEnabled: true }, 0)
    const off = computeReconciledFees(100000, cfg, DEFAULT_COMMERCIAL_MODEL, 0)
    expect(off.gatewayFeeGstPaise).toBe(0)
    expect(on.gatewayFeeGstPaise).toBe(Math.round(on.gatewayFeeBasePaise * 18 / 100))
  })

  it('convenience fee applies only when enabled and is attendee-borne', () => {
    const on = computeReconciledFees(100000, cfg, { ...DEFAULT_COMMERCIAL_MODEL, convenienceFeeEnabled: true }, 100)
    expect(on.convenienceFeePaise).toBe(100)
    expect(on.attendeeBearsPaise).toBeGreaterThanOrEqual(100)
    const off = computeReconciledFees(100000, cfg, DEFAULT_COMMERCIAL_MODEL, 100)
    expect(off.convenienceFeePaise).toBe(0)
  })

  it('platform revenue is base + convenience (GST excluded), never negative', () => {
    const fees = computeReconciledFees(100000, cfg, DEFAULT_COMMERCIAL_MODEL, 0)
    expect(fees.platformRevenuePaise).toBe(fees.platformFeeBasePaise)
    expect(fees.platformRevenuePaise).toBeGreaterThanOrEqual(0)
  })

  it('zero / negative gross → pass-through zero', () => {
    expect(computeReconciledFees(0, cfg, DEFAULT_COMMERCIAL_MODEL).chargeAmountPaise).toBe(0)
    expect(computeReconciledFees(-5, cfg, DEFAULT_COMMERCIAL_MODEL).netSettlementPaise).toBe(0)
  })
})

describe('commercialToFeeModel', () => {
  it('maps the default to organizer_pays', () => {
    expect(commercialToFeeModel(DEFAULT_COMMERCIAL_MODEL)).toBe('organizer_pays')
  })
  it('maps attendee-both (no extras) to customer_pays', () => {
    expect(commercialToFeeModel({ platformFeePaidBy: 'attendee', gatewayFeePaidBy: 'attendee', platformGstEnabled: true, gatewayGstEnabled: false, convenienceFeeEnabled: false })).toBe('customer_pays')
  })
  it('returns null for models with no production equivalent', () => {
    expect(commercialToFeeModel({ ...DEFAULT_COMMERCIAL_MODEL, gatewayGstEnabled: true })).toBeNull()
  })
})

describe('units — the single ₹↔paise boundary', () => {
  it('rupeesToPaise rounds to integer paise', () => {
    expect(rupeesToPaise(2)).toBe(200)
    expect(rupeesToPaise(0)).toBe(0)
    expect(PAISE_PER_RUPEE).toBe(100)
  })
  it('paiseToRupees is the inverse', () => {
    expect(paiseToRupees(200)).toBe(2)
    expect(paiseToRupees(149900)).toBe(1499)
  })
})
