// RD-GA-HARDEN-01 — wallet settlement.
//   • resolveWalletSettlementPure (walletSettlement.ts) — snapshot-first, guaranteed == stored.
//   • computeWalletDebit (revenueWallets.ts) — pending-first debit + insolvency.
//
// revenueWallets imports the eagerly-initialized Admin SDK, so it is mocked away.

import { describe, it, expect, vi } from 'vitest'
import { resolveWalletSettlementPure } from '@/lib/platform/pricing/walletSettlement'
import { createOrderPricingSnapshot, serializeOrderPricingSnapshot } from '@/lib/platform/pricing/orderSnapshot'
import { buildPricingSummary } from '../fixtures/pricingSummary'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminApp: {}, adminAuth: {} }))
import { computeWalletDebit } from '@/lib/firebase/firestore/revenueWallets'

describe('resolveWalletSettlementPure — reverses exactly what was credited', () => {
  it('uses the snapshot value when it equals the stored settlement', () => {
    const summary = buildPricingSummary()
    const json = serializeOrderPricingSnapshot(createOrderPricingSnapshot(summary))
    const stored = summary.organizerReceives.paise
    const r = resolveWalletSettlementPure({ netSettlementPaise: stored, pricingSnapshot: json })
    expect(r.source).toBe('snapshot')
    expect(r.netSettlementPaise).toBe(stored)   // byte-identical to credited amount
  })

  it('falls back to the stored value when the snapshot settlement differs (never drifts)', () => {
    const json = serializeOrderPricingSnapshot(createOrderPricingSnapshot(buildPricingSummary({ ticketPricePaise: 100000 })))
    const stored = 12345   // deliberately != the snapshot's organizerReceives (95050)
    const r = resolveWalletSettlementPure({ netSettlementPaise: stored, pricingSnapshot: json })
    expect(r.source).toBe('mismatch')
    expect(r.netSettlementPaise).toBe(stored)   // still reverses exactly the credited amount
  })

  it('falls back when no snapshot is present', () => {
    const r = resolveWalletSettlementPure({ netSettlementPaise: 95050 })
    expect(r.source).toBe('fallback')
    expect(r.netSettlementPaise).toBe(95050)
  })

  it('falls back on a tampered snapshot (checksum failure)', () => {
    const summary = buildPricingSummary()
    const json = serializeOrderPricingSnapshot(createOrderPricingSnapshot(summary))
      .replace(/"platformRevenue":\{[^}]*\}/, '"platformRevenue":{"paise":1,"rupees":0.01}')
    const r = resolveWalletSettlementPure({ netSettlementPaise: summary.organizerReceives.paise, pricingSnapshot: json })
    expect(r.source).toBe('checksum_failure')
    expect(r.netSettlementPaise).toBe(summary.organizerReceives.paise)
  })
})

describe('computeWalletDebit — pending-first, insolvency-safe', () => {
  it('debits from pending first, then available', () => {
    expect(computeWalletDebit({ pendingPaise: 10000, availablePaise: 5000 }, 12000))
      .toEqual({ fromPending: 10000, fromAvailable: 2000, totalDebited: 12000 })
  })
  it('clamps at the balance when insolvent (never over-debits)', () => {
    const plan = computeWalletDebit({ pendingPaise: 1000, availablePaise: 500 }, 5000)
    expect(plan.totalDebited).toBe(1500)
    expect(plan.totalDebited).toBeLessThan(5000)   // shortfall → clawback territory
  })
  it('debits nothing for a zero reversal', () => {
    expect(computeWalletDebit({ pendingPaise: 1000, availablePaise: 1000 }, 0).totalDebited).toBe(0)
  })
})
