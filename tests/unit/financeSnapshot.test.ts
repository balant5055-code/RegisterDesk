// RD-GA-HARDEN-01 — finance/report READ model (financeSnapshot.ts): snapshot-first,
// output guaranteed byte-equal to the stored historical ledger; never recalculates.

import { describe, it, expect } from 'vitest'
import { readFinanceFromLedger, readReportFromLedger } from '@/lib/platform/pricing/financeSnapshot'
import { buildPricingSummary } from '../fixtures/pricingSummary'
import { ledgerFromSummary } from '../fixtures/ledger'

type LedgerDoc = Parameters<typeof readFinanceFromLedger>[0]

describe('readFinanceFromLedger', () => {
  const summary = buildPricingSummary()

  it('sources from the snapshot when every figure equals the ledger', () => {
    const doc = ledgerFromSummary(summary) as unknown as LedgerDoc
    const fig = readFinanceFromLedger(doc)
    expect(fig.source).toBe('snapshot')
    expect(fig.netSettlementPaise).toBe(summary.organizerReceives.paise)
    expect(fig.platformFeeTotalPaise).toBe(summary.platformFeeTotal.paise)
  })

  it('falls back to ledger values when a stored figure differs from the snapshot', () => {
    const doc = { ...(ledgerFromSummary(summary) as Record<string, unknown>), netSettlementPaise: 1 } as unknown as LedgerDoc
    const fig = readFinanceFromLedger(doc)
    expect(fig.source).toBe('fallback')
    expect(fig.netSettlementPaise).toBe(1)   // exactly the stored ledger value
  })

  it('falls back when there is no snapshot (historical order)', () => {
    const doc = ledgerFromSummary(summary, { withSnapshot: false }) as unknown as LedgerDoc
    expect(readFinanceFromLedger(doc).source).toBe('fallback')
  })

  it('falls back on a checksum failure without throwing', () => {
    const base = ledgerFromSummary(summary) as Record<string, unknown>
    const doc = { ...base, pricingSnapshot: String(base.pricingSnapshot).replace(/"platformRevenue":\{[^}]*\}/, '"platformRevenue":{"paise":9,"rupees":0.09}') } as unknown as LedgerDoc
    expect(readFinanceFromLedger(doc).source).toBe('fallback')
  })
})

describe('readReportFromLedger — same guarantees, report namespace', () => {
  it('equals the ledger figures', () => {
    const summary = buildPricingSummary({ ticketPricePaise: 249900 })
    const fig = readReportFromLedger(ledgerFromSummary(summary) as unknown as LedgerDoc)
    expect(fig.grossAmountPaise).toBe(summary.ticketPrice.paise)
    expect(fig.netSettlementPaise).toBe(summary.organizerReceives.paise)
  })
})
