// RD-REFUND-MANUAL-01 — the PURE rules of manual attendee refunds, plus source contracts that pin the
// exclusivity guards in the gateway paths. The Firestore behaviour is covered by
// tests/emulator/manualRefunds.emu.test.ts.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import {
  manualRefundId, isManualRefundMethod, buildRecipient, canonicalReference, isIsoDate,
  checkRefundAmount, sumManualRefunds, hasCountedGatewayRefunds, planManualReversal, releasableNetAfterManualRefunds,
} from '@/lib/refunds/manualRefundRules'
import { pendingRefundMatches } from '@/lib/refunds/refundPolicy'
import { calculateFee } from '@/lib/fees/engine'

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('the ₹30 registration under the current policy', () => {
  it('₹0.35 platform fee incl. GST + ₹0.75 estimated gateway fee ⇒ ₹28.90 organizer net', () => {
    const r = calculateFee({
      transactionType: 'event_registration', grossAmountPaise: 3000, feeModel: 'organizer_pays',
      config: { platformFeePercentBps: 100, platformFeeFixedPaise: 0, platformFeeMinPaise: 0, platformFeeMaxPaise: 0, gatewayFeePercentBps: 250, gatewayFeeFixedPaise: 0, gstRatePercent: 18 },
    })
    expect(r.platformFeeBasePaise).toBe(30)
    expect(r.platformFeeGstPaise).toBe(5)
    expect(r.platformFeeTotalPaise).toBe(35)
    expect(r.gatewayFeeEstimatePaise).toBe(75)
    expect(r.chargeAmountPaise).toBe(3000)
    expect(r.netSettlementPaise).toBe(2890)
  })

  it('a full manual refund reverses exactly that net', () => {
    expect(planManualReversal({ chargedPaise: 3000, netPaise: 2890, alreadyRefundedGrossPaise: 0, refundGrossPaise: 3000, alreadyReversedNetPaise: 0 }))
      .toEqual({ reversalNetPaise: 2890, fullyRefunded: true })
  })

  it('partial refunds are proportional and cumulatively exact (₹10 then ₹20 ⇒ 963 + 1927 = 2890)', () => {
    const a = planManualReversal({ chargedPaise: 3000, netPaise: 2890, alreadyRefundedGrossPaise: 0, refundGrossPaise: 1000, alreadyReversedNetPaise: 0 })
    expect(a).toEqual({ reversalNetPaise: 963, fullyRefunded: false })
    const b = planManualReversal({ chargedPaise: 3000, netPaise: 2890, alreadyRefundedGrossPaise: 1000, refundGrossPaise: 2000, alreadyReversedNetPaise: 963 })
    expect(b).toEqual({ reversalNetPaise: 1927, fullyRefunded: true })
    expect(releasableNetAfterManualRefunds(2890, 963)).toBe(1927)
    expect(releasableNetAfterManualRefunds(2890, 2890)).toBe(0)
    expect(releasableNetAfterManualRefunds(2890, undefined)).toBe(2890)
    expect(releasableNetAfterManualRefunds(100, 500)).toBe(0)
  })
})

describe('validation', () => {
  it('ids come from a well-formed idempotency key', () => {
    expect(manualRefundId('reg_1', 'abcdefgh')).toBe('mrr_reg_1_abcdefgh')
    expect(manualRefundId('reg_1', 'short')).toBeNull()
    expect(manualRefundId('reg/1', 'abcdefgh')).toBeNull()
    expect(manualRefundId('reg_1', 42)).toBeNull()
  })

  it('methods are a closed list', () => {
    expect(isManualRefundMethod('upi')).toBe(true)
    expect(isManualRefundMethod('razorpay')).toBe(false)
  })

  it('recipient details are stored MASKED', () => {
    const bank = buildRecipient('bank_transfer', 'Asha Rao', '1234 5678 9012')!
    expect(bank.detail).not.toContain('12345678')
    expect(bank.detail).toMatch(/9012$/)
    const upi = buildRecipient('upi', 'Asha Rao', 'asha.rao@okaxis')!
    expect(upi.detail).not.toContain('asha.rao')
    expect(buildRecipient('upi', 'Asha Rao', 'not-a-vpa')).toBeNull()
    expect(buildRecipient('bank_transfer', 'Asha Rao', 'abc')).toBeNull()
    expect(buildRecipient('cash', 'A', null)).toBeNull()
    expect(buildRecipient('cash', 'Asha Rao', null)).toEqual({ name: 'Asha Rao', detail: null })
  })

  it('references are canonical; dates are real calendar dates', () => {
    expect(canonicalReference(' utr-123 456_ab ')).toBe('UTR123456AB')
    expect(canonicalReference('UTR#1')).toBeNull()
    expect(isIsoDate('2026-10-20')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('20-10-2026')).toBe(false)
  })

  it('amounts are positive integer paise within what is still refundable', () => {
    expect(checkRefundAmount(3000, 3000, 0)).toEqual({ ok: true, amountPaise: 3000, fullRefund: true })
    expect(checkRefundAmount(1000, 3000, 0)).toEqual({ ok: true, amountPaise: 1000, fullRefund: false })
    expect(checkRefundAmount(2000, 3000, 1000)).toEqual({ ok: true, amountPaise: 2000, fullRefund: true })
    expect(checkRefundAmount(2001, 3000, 1000)).toEqual({ ok: false, code: 'EXCEEDS_REFUNDABLE' })
    for (const bad of [0, -1, 10.5, '100', NaN]) expect(checkRefundAmount(bad, 3000, 0)).toEqual({ ok: false, code: 'INVALID_AMOUNT' })
  })

  it('sums and gateway detection tolerate junk', () => {
    expect(sumManualRefunds({ a: 1000, b: 500, c: 'x', d: -3 })).toBe(1500)
    expect(sumManualRefunds(undefined)).toBe(0)
    expect(hasCountedGatewayRefunds({ rfnd_1: 100 })).toBe(true)
    expect(hasCountedGatewayRefunds({})).toBe(false)
    expect(hasCountedGatewayRefunds(null)).toBe(false)
  })
})

describe('exclusivity with gateway refunds', () => {
  it('a gateway refund never finishes a MANUAL refund claim', () => {
    const reg = { paymentStatus: 'refund_pending', paymentId: 'pay_1', amount: 3000 }
    expect(pendingRefundMatches({ ...reg, refundClaim: { paymentId: 'pay_1', amountPaise: 3000 } }, { gatewayPaymentId: 'pay_1', amountPaise: 3000 })).toBe(true)
    expect(pendingRefundMatches({ ...reg, refundClaim: { kind: 'manual', paymentId: 'pay_1', amountPaise: 3000 } }, { gatewayPaymentId: 'pay_1', amountPaise: 3000 })).toBe(false)
  })

  it('every gateway path refuses or holds when a manual refund exists (source contracts)', () => {
    const webhook = src('app/api/webhooks/razorpay/route.ts')
    expect(webhook).toMatch(/acc\.kind === 'manual_conflict'/)
    const acc = src('lib/refunds/registrationRefunds.ts')
    expect(acc).toMatch(/manualRefundsPaise/)
    expect(acc).toMatch(/'manual_refund_conflict'/)
    const route = src('app/api/organizer/registrations/[registrationId]/refund/route.ts')
    expect(route.match(/manualRefunds\)?\??\.refundedPaise/g)?.length ?? 0).toBeGreaterThanOrEqual(2)   // preflight + in the claim transaction
    expect(src('app/api/admin/failed-refunds/[id]/retry/route.ts')).toMatch(/manualRefundsPaise/)
    expect(src('lib/firebase/firestore/platformTransactions.ts')).toMatch(/MANUAL_REFUND_PRESENT/)
    expect(src('lib/settlements/releaseFunds.ts')).toMatch(/releasableNetAfterManualRefunds\(/)
  })

  it('both manual-refund routes are Super Admin only and take a financial reason', () => {
    for (const p of ['app/api/admin/registrations/[registrationId]/manual-refunds/route.ts', 'app/api/admin/manual-refunds/[id]/route.ts']) {
      const s = src(p)
      expect(s).toMatch(/requireSuperAdmin\(req\)/)
      expect(s).toMatch(/parseFinancialReason\(/)
    }
  })
})
