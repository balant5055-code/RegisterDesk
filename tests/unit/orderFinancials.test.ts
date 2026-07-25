// RD-GA-HARDEN-01 — payment ledger financial source (orderFinancials.ts):
// snapshot-first with lib/fees fallback; snapshot used only when shadow matched.

import { describe, it, expect } from 'vitest'
import { resolveLedgerFinancials } from '@/lib/platform/pricing/orderFinancials'
import { calculateFee } from '@/lib/fees/engine'
import { createOrderPricingSnapshot, serializeOrderPricingSnapshot } from '@/lib/platform/pricing/orderSnapshot'
import { buildPricingSummary } from '../fixtures/pricingSummary'
import { feeConfigFor } from '../fixtures/feeConfig'

const feeResult = calculateFee({ transactionType: 'event_registration', grossAmountPaise: 100000, feeModel: 'organizer_pays', config: feeConfigFor('starter') })
const snapshotJson = serializeOrderPricingSnapshot(createOrderPricingSnapshot(buildPricingSummary({ ticketPricePaise: 100000 })))

describe('resolveLedgerFinancials', () => {
  it('uses the snapshot when valid AND shadow matched', () => {
    const fin = resolveLedgerFinancials(feeResult, { pricingSnapshot: snapshotJson, pricingSnapshotMeta: shadowMeta(true) })
    expect(fin.source).toBe('snapshot')
    expect(fin.netSettlementPaise).toBe(feeResult.netSettlementPaise)   // provably equal
    expect(fin.platformFeeTotalPaise).toBe(feeResult.platformFeeTotalPaise)
  })

  it('falls back to lib/fees when the shadow mismatched', () => {
    const fin = resolveLedgerFinancials(feeResult, { pricingSnapshot: snapshotJson, pricingSnapshotMeta: shadowMeta(false) })
    expect(fin.source).toBe('fallback')
    expect(fin.netSettlementPaise).toBe(feeResult.netSettlementPaise)
  })

  it('falls back when there is no snapshot', () => {
    expect(resolveLedgerFinancials(feeResult, {}).source).toBe('fallback')
  })

  it('falls back on a tampered/corrupt snapshot (never throws)', () => {
    const fin = resolveLedgerFinancials(feeResult, { pricingSnapshot: '{bad', pricingSnapshotMeta: shadowMeta(true) })
    expect(fin.source).toBe('fallback')
    expect(fin.netSettlementPaise).toBe(feeResult.netSettlementPaise)
  })
})

function shadowMeta(shadowMatch: boolean) {
  return {
    pricingVersion: 2, configurationVersion: 1, snapshotVersion: 1,
    platformFeePaidBy: 'organizer', gatewayFeePaidBy: 'organizer',
    platformGstEnabled: true, gatewayGstEnabled: false, convenienceFeeEnabled: false,
    shadowMatch, shadowDifferenceCount: shadowMatch ? 0 : 3,
  }
}
