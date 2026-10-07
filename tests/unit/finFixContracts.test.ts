// RD-FIN-02 · wiring contracts for the fix pass. The money arithmetic is proven on real Firestore in
// tests/emulator/registrationFinanceFixes.emu.test.ts; these pin the route / UI wiring that an
// emulator cannot see (which scope a route passes, what a screen calls a figure).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isInPlaceReversal } from '@/lib/finance/ledgerReversal'
import { registrationRevenueBasisPaise, settlementRevenueBasisPaise } from '@/lib/registrations/revenueBasis'
import { pendingRefundMatches } from '@/lib/refunds/refundPolicy'
import { PAID_PAYMENT_STATUSES } from '@/lib/registrations/types'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('P2 · Finance: one meaning for the date range', () => {
  const ROUTE = read('app/api/organizer/finance/analytics/route.ts')
  const UI    = read('components/dashboard/finance/FinanceControlCenter.tsx')
  it('every total is computed LIFETIME; only the trend receives the window', () => {
    expect(ROUTE).toContain('const scope:      FinanceScope = { organizerUid: uid, eventSlug, from: null, to: null }')
    expect(ROUTE).toContain('const trendScope: FinanceScope = { organizerUid: uid, eventSlug, from, to }')
    expect(ROUTE).toContain('getTrend(trendScope, effective)')
    expect(ROUTE).toContain("totals: 'lifetime'")
    for (const call of ['getLedgerTotals(scope)', 'getRefundTotals(scope)', 'getRegistrationSplit(scope, PAYMENT_STATUSES)', 'getStatusBreakdown(scope, LEDGER_STATUSES)']) {
      expect(ROUTE).toContain(call)
    }
  })
  it('the UI labels the toggle as the TREND window and says totals are lifetime', () => {
    expect(UI).toContain('aria-label="Trend window"')
    expect(UI).toContain('Totals are lifetime')
    expect(UI).not.toContain('aria-label="Date range"')
  })
})

describe('P6 · dashboard settlement card: one stated scope', () => {
  const ROUTE = read('app/api/organizer/dashboard/route.ts')
  const PAGE  = read('app/(dashboard)/dashboard/page.tsx')
  it('all-events Attendee paid covers the SAME population as the ledger (every owned event, archived included)', () => {
    expect(ROUTE).toContain('const settlementSlugs = scoped ? scopedSlugs : Array.from(new Set(ownedSlugs.values()))')
    expect(ROUTE).toContain('getAttendeePaid(settlementSlugs, ATTENDEE_PAID_STATUSES)')
    expect(ROUTE).toContain("scope:                  scoped ? 'event' : 'workspace_lifetime',")
  })
  it('the card says what it covers', () => {
    expect(PAGE).toContain('Lifetime · all events incl. archived')
    expect(PAGE).toContain('Organizer payable (after refunds)')
  })
})

describe('P7 · the "Paid" tiles show the canonical charged population', () => {
  it('Analytics and Super Admin tiles read paidCharged; the definition is paid + refund_pending + refunded', () => {
    expect([...PAID_PAYMENT_STATUSES].sort()).toEqual(['paid', 'refund_pending', 'refunded'])
    expect(read('app/(dashboard)/dashboard/analytics/page.tsx')).toContain('countOf(data.kpis.paidCharged)')
    expect(read('app/(admin)/admin/events/[slug]/PageClient.tsx')).toContain('countOf(a.kpis.paidCharged)')
    expect(read('app/api/organizer/finance/analytics/route.ts')).toContain("const PAYMENT_STATUSES = ['paid', 'not_required', 'refunded', 'refund_pending', 'pending'] as const")
  })
})

describe('pure rules', () => {
  it('B5 · revenue basis: amount − attendee fee; absent fee ⇒ amount; never negative; settlement basis capped at the charge', () => {
    expect(registrationRevenueBasisPaise({ amount: 52_360, attendeeFeePaise: 2_360 })).toBe(50_000)
    expect(registrationRevenueBasisPaise({ amount: 50_000 })).toBe(50_000)
    expect(registrationRevenueBasisPaise({ amount: 100, attendeeFeePaise: 500 })).toBe(0)
    expect(registrationRevenueBasisPaise({ amount: 'x', attendeeFeePaise: -5 })).toBe(0)
    expect(settlementRevenueBasisPaise({ amount: 52_360, financials: { ticketBasePaise: 50_000 } })).toBe(50_000)
    expect(settlementRevenueBasisPaise({ amount: 40_000, financials: { ticketBasePaise: 50_000 } })).toBe(40_000)
    expect(settlementRevenueBasisPaise({ amount: 50_000 })).toBe(50_000)
  })
  it('P3/P4 · in-place reversal = a refunded/disputed REGISTRATION row; donation rows and reversal rows are not', () => {
    expect(isInPlaceReversal({ status: 'refunded', sourceType: 'registration' })).toBe(true)
    expect(isInPlaceReversal({ status: 'disputed', sourceType: 'registration' })).toBe(true)
    expect(isInPlaceReversal({ status: 'completed', sourceType: 'registration' })).toBe(false)
    expect(isInPlaceReversal({ status: 'refunded', sourceType: 'donation' })).toBe(false)
    expect(isInPlaceReversal({ status: 'refunded', parentTransactionId: 'ptx_x' })).toBe(false)
    expect(isInPlaceReversal({ status: 'backfilled' })).toBe(false)
  })
  it('P13 · a pending refund completes only on matching evidence (same payment, same amount)', () => {
    const reg = { paymentStatus: 'refund_pending', paymentId: 'pay_1', amount: 500, refundClaim: { paymentId: 'pay_1', amountPaise: 500 } }
    expect(pendingRefundMatches(reg, { gatewayPaymentId: 'pay_1', amountPaise: 500 })).toBe(true)
    expect(pendingRefundMatches(reg, { gatewayPaymentId: 'pay_2', amountPaise: 500 })).toBe(false)
    expect(pendingRefundMatches(reg, { gatewayPaymentId: 'pay_1', amountPaise: 499 })).toBe(false)
    expect(pendingRefundMatches(reg, { gatewayPaymentId: null, amountPaise: 500 })).toBe(false)
    expect(pendingRefundMatches({ ...reg, paymentStatus: 'paid' }, { gatewayPaymentId: 'pay_1', amountPaise: 500 })).toBe(false)
  })
})
