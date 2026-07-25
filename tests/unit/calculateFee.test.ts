// RD-GA-HARDEN-01 — production fee engine (lib/fees/engine.ts calculateFee).
// Golden values lock the live fee math against regression (historical consistency).

import { describe, it, expect } from 'vitest'
import { calculateFee } from '@/lib/fees/engine'
import { feeConfigFor, ALL_PLAN_TIERS } from '../fixtures/feeConfig'

const base = (gross: number, feeModel: 'organizer_pays' | 'customer_pays' | 'hybrid' | 'no_fee', tier = 'starter' as const, extra = {}) =>
  calculateFee({ transactionType: 'event_registration', grossAmountPaise: gross, feeModel, config: feeConfigFor(tier), ...extra })

describe('calculateFee — golden values (starter / ticketed / ₹1000)', () => {
  it('organizer_pays: attendee charged gross, organizer nets gross − fees', () => {
    const r = base(100000, 'organizer_pays')
    expect(r.platformFeeBasePaise).toBe(2500)   // 2% + ₹5 fixed
    expect(r.platformFeeGstPaise).toBe(450)     // 18% of base
    expect(r.platformFeeTotalPaise).toBe(2950)
    expect(r.gatewayFeeEstimatePaise).toBe(2000) // 2%
    expect(r.chargeAmountPaise).toBe(100000)     // Razorpay order = gross
    expect(r.netSettlementPaise).toBe(95050)     // gross − 2950 − 2000
    expect(r.organizerBearsPlatformFee).toBe(2950)
    expect(r.customerBearsPlatformFee).toBe(0)
  })

  it('customer_pays: attendee charged gross + all fees, organizer nets gross', () => {
    const r = base(100000, 'customer_pays')
    expect(r.chargeAmountPaise).toBe(104950)     // 100000 + 2950 + 2000
    expect(r.netSettlementPaise).toBe(100000)
    expect(r.customerBearsPlatformFee).toBe(2950)
    expect(r.customerBearsGatewayFee).toBe(2000)
  })

  it('hybrid (0.5): platform fee split; gateway on organizer', () => {
    const r = base(100000, 'hybrid', 'starter', { hybridRatio: 0.5 })
    expect(r.customerBearsPlatformFee).toBe(1475)
    expect(r.organizerBearsPlatformFee).toBe(1475)
    expect(r.chargeAmountPaise).toBe(101475)     // gross + customer share
    expect(r.netSettlementPaise).toBe(96525)     // gross − organizer share − gateway
  })
})

describe('calculateFee — clamps, edge cases', () => {
  it('pro tier caps the platform fee at ₹500', () => {
    const r = calculateFee({ transactionType: 'event_registration', grossAmountPaise: 10_000_000, feeModel: 'organizer_pays', config: feeConfigFor('pro') })
    // 1% of ₹1,00,000 = ₹1000 raw, capped to ₹500 (50000 paise)
    expect(r.platformFeeBasePaise).toBe(50000)
  })

  it('free tier applies the ₹5 minimum + fixed component', () => {
    const r = base(100000, 'organizer_pays', 'free')
    expect(r.platformFeeBasePaise).toBe(3500)   // 3% + ₹5
  })

  it('no_fee and zero-gross yield a pass-through zero result', () => {
    expect(base(0, 'organizer_pays')).toMatchObject({ chargeAmountPaise: 0, netSettlementPaise: 0, platformFeeTotalPaise: 0 })
    expect(base(100000, 'no_fee')).toMatchObject({ chargeAmountPaise: 100000, netSettlementPaise: 100000, platformFeeTotalPaise: 0 })
  })

  it('is deterministic — identical input → identical output (no regression)', () => {
    for (const tier of ALL_PLAN_TIERS) {
      const a = calculateFee({ transactionType: 'event_registration', grossAmountPaise: 149900, feeModel: 'organizer_pays', config: feeConfigFor(tier) })
      const b = calculateFee({ transactionType: 'event_registration', grossAmountPaise: 149900, feeModel: 'organizer_pays', config: feeConfigFor(tier) })
      expect(a).toEqual(b)
    }
  })

  it('never lets organizer settlement go negative', () => {
    const r = base(100, 'organizer_pays') // tiny gross, ₹5 min fee > gross
    expect(r.netSettlementPaise).toBeGreaterThanOrEqual(0)
  })
})
