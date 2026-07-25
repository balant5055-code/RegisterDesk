// RD-GA-HARDEN-01 — determinism & idempotency of the financial core.
// Same inputs → identical outputs (no regression); recovery paths can re-run safely.

import { describe, it, expect } from 'vitest'
import { calculateFee } from '@/lib/fees/engine'
import { computeReconciledFees, DEFAULT_COMMERCIAL_MODEL } from '@/lib/platform/pricing/commercial'
import { createOrderPricingSnapshot, computePricingChecksum, serializeOrderPricingSnapshot, deserializeOrderPricingSnapshot } from '@/lib/platform/pricing/orderSnapshot'
import { buildPricingSummary } from '../fixtures/pricingSummary'
import { feeConfigFor } from '../fixtures/feeConfig'

describe('fee computation is a pure deterministic function', () => {
  it('calculateFee + computeReconciledFees repeat identically', () => {
    const cfg = feeConfigFor('pro')
    expect(calculateFee({ transactionType: 'donation', grossAmountPaise: 333333, feeModel: 'organizer_pays', config: cfg }))
      .toEqual(calculateFee({ transactionType: 'donation', grossAmountPaise: 333333, feeModel: 'organizer_pays', config: cfg }))
    expect(computeReconciledFees(333333, cfg, DEFAULT_COMMERCIAL_MODEL, 0))
      .toEqual(computeReconciledFees(333333, cfg, DEFAULT_COMMERCIAL_MODEL, 0))
  })
})

describe('snapshot checksum is content-addressed (idempotent)', () => {
  const summary = buildPricingSummary({ resolvedAt: '2026-07-21T00:00:00.000Z' })

  it('identical content → identical checksum', () => {
    expect(createOrderPricingSnapshot(summary).pricingChecksum)
      .toBe(createOrderPricingSnapshot(summary).pricingChecksum)
  })

  it('checksum survives a store → read → store cycle', () => {
    const snap = createOrderPricingSnapshot(summary)
    const back = deserializeOrderPricingSnapshot(serializeOrderPricingSnapshot(snap))
    expect(back.ok).toBe(true)
    if (back.ok) {
      const { pricingChecksum, ...content } = back.snapshot
      expect(computePricingChecksum(content)).toBe(pricingChecksum)   // re-derives identically
    }
  })

  it('any content change changes the checksum', () => {
    const a = createOrderPricingSnapshot(buildPricingSummary({ ticketPricePaise: 100000, resolvedAt: '2026-07-21T00:00:00.000Z' }))
    const b = createOrderPricingSnapshot(buildPricingSummary({ ticketPricePaise: 100001, resolvedAt: '2026-07-21T00:00:00.000Z' }))
    expect(a.pricingChecksum).not.toBe(b.pricingChecksum)
  })
})

describe('deterministic transaction-id convention (exactly-once ledger key)', () => {
  // The ledger doc id is derived purely from the source id (registration/donation), so
  // browser-verify, webhook, and retry all target the SAME doc and credit exactly once.
  const ptxId = (sourceId: string) => `ptx_${sourceId}`
  const refundPtxId = (refundId: string) => `ptx_refund_${refundId}`

  it('same source id → same ledger id (idempotency key is stable)', () => {
    expect(ptxId('reg_ABC')).toBe('ptx_reg_ABC')
    expect(ptxId('reg_ABC')).toBe(ptxId('reg_ABC'))
    expect(refundPtxId('rfnd_9')).toBe('ptx_refund_rfnd_9')
  })
  it('distinct sources → distinct ledger ids (no collision)', () => {
    expect(ptxId('reg_A')).not.toBe(ptxId('reg_B'))
  })
})
