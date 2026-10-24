// Phase 3.3 — the pure rules of the residual financial-integrity fixes (no Firestore):
//   B · cumulative donation refund reversal (integer paise, never over the remaining net, exact on completion)
//   C · what a clawback still leaves in the wallet (off-platform recovery is NOT owed by the wallet)
//   F · bounded queues (attempt cap, sweep check backoff) / permanent-error classification

import { describe, it, expect, vi } from 'vitest'
import { planDonationReversal, proportionalReversal } from '@/lib/donations/reversalMath'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const { clawbackWalletHeldPaise, clawbackArithmeticGap } = await import('@/lib/reconciliation/wallets')
const { isPermanentRefundQueueError, REFUND_QUEUE_MAX_ATTEMPTS } = await import('@/lib/payments/registrationReconciliation')
const { attemptCheckBackoffMs, isPermanentAccountingError } = await import('@/lib/donations/refundService')

/** Runs a sequence of refunds through the plan exactly as the accounting does (cumulative state carried). */
function run(gross: number, net: number, refunds: number[]) {
  let refunded = 0, reversed = 0
  const steps = refunds.map(r => {
    const p = planDonationReversal({ grossPaise: gross, netPaise: net, alreadyRefundedGrossPaise: refunded, refundGrossPaise: r, alreadyReversedNetPaise: reversed })
    refunded += r; reversed += p.reversalNetPaise
    return p.reversalNetPaise
  })
  return { steps, reversed }
}

describe('B · planDonationReversal — cumulatively exact', () => {
  it('100,000 / 95,000 refunded 33,333 + 33,333 + 33,334 reverses EXACTLY 95,000 (no 1-paisa residue)', () => {
    const r = run(100_000, 95_000, [33_333, 33_333, 33_334])
    expect(r.steps).toEqual([31_666, 31_666, 31_668])
    expect(r.reversed).toBe(95_000)
  })
  it('100,000 / 95,000 refunded 10 + 99,990 reverses EXACTLY 95,000 (no 1-paisa over-reversal)', () => {
    const r = run(100_000, 95_000, [10, 99_990])
    expect(r.steps).toEqual([10, 94_990])          // the old per-refund rounding gave 10 + 94,991 = 95,001
    expect(r.reversed).toBe(95_000)
  })
  it('999 / 950 refunded 333 × 3 reverses EXACTLY 950 (old rounding: 317 × 3 = 951)', () => {
    const r = run(999, 950, [333, 333, 333])
    expect(r.steps).toEqual([317, 317, 316])
    expect(r.reversed).toBe(950)
  })
  it('a partial refund takes the proportional share, never more than what remains', () => {
    expect(planDonationReversal({ grossPaise: 1_000, netPaise: 900, alreadyRefundedGrossPaise: 0, refundGrossPaise: 400, alreadyReversedNetPaise: 0 }))
      .toEqual({ reversalNetPaise: 360, completesGross: false, remainingNetPaise: 900 })
    // remainder smaller than the share (earlier rounding up) ⇒ capped at the remainder
    expect(planDonationReversal({ grossPaise: 1_000, netPaise: 900, alreadyRefundedGrossPaise: 500, refundGrossPaise: 400, alreadyReversedNetPaise: 600 }).reversalNetPaise).toBe(300)
  })
  it('over-refund attempts (cumulative > gross) and refunds after completion never exceed the net', () => {
    expect(planDonationReversal({ grossPaise: 1_000, netPaise: 950, alreadyRefundedGrossPaise: 800, refundGrossPaise: 500, alreadyReversedNetPaise: 760 }))
      .toMatchObject({ reversalNetPaise: 190, completesGross: true })
    expect(planDonationReversal({ grossPaise: 1_000, netPaise: 950, alreadyRefundedGrossPaise: 1_000, refundGrossPaise: 100, alreadyReversedNetPaise: 950 }).reversalNetPaise).toBe(0)
    // a remainder already over-reversed by legacy rounding never goes negative
    expect(planDonationReversal({ grossPaise: 1_000, netPaise: 950, alreadyRefundedGrossPaise: 500, refundGrossPaise: 500, alreadyReversedNetPaise: 951 }).reversalNetPaise).toBe(0)
  })
  it('a single full refund reverses the whole net; zero / negative inputs reverse nothing', () => {
    expect(planDonationReversal({ grossPaise: 777, netPaise: 701, alreadyRefundedGrossPaise: 0, refundGrossPaise: 777, alreadyReversedNetPaise: 0 }).reversalNetPaise).toBe(701)
    expect(planDonationReversal({ grossPaise: 777, netPaise: 0, alreadyRefundedGrossPaise: 0, refundGrossPaise: 777, alreadyReversedNetPaise: 0 }).reversalNetPaise).toBe(0)
    expect(proportionalReversal(0, 10, 10)).toBe(0)
  })
  it('exhaustive small-amount sweep: any split of the gross reverses exactly the net, every step an integer ≥ 0', () => {
    for (const [gross, net] of [[999, 950], [1_001, 3], [7, 6], [100, 99]] as const) {
      for (let a = 1; a < gross; a += Math.max(1, Math.floor(gross / 37))) {
        for (let b = 1; a + b < gross; b += Math.max(1, Math.floor(gross / 23))) {
          const r = run(gross, net, [a, b, gross - a - b])
          expect(r.reversed).toBe(net)
          for (const s of r.steps) { expect(Number.isInteger(s)).toBe(true); expect(s).toBeGreaterThanOrEqual(0) }
        }
      }
    }
  })
})

describe('C · clawbackWalletHeldPaise', () => {
  it('outstanding debt counts while open / partially recovered / waived', () => {
    expect(clawbackWalletHeldPaise({ status: 'open', outstandingAmountPaise: 500 })).toBe(500)
    expect(clawbackWalletHeldPaise({ status: 'partially_recovered', outstandingAmountPaise: 200 })).toBe(200)
    expect(clawbackWalletHeldPaise({ status: 'waived', outstandingAmountPaise: 700 })).toBe(700)
    expect(clawbackWalletHeldPaise({ status: 'recovered', outstandingAmountPaise: 0 })).toBe(0)
  })
  it('off-platform recovery is still in the wallet (never debited) — in any status; wallet-funded recovery is not', () => {
    expect(clawbackWalletHeldPaise({ status: 'recovered', outstandingAmountPaise: 0, offPlatformRecoveredAmountPaise: 60_000 })).toBe(60_000)
    expect(clawbackWalletHeldPaise({ status: 'partially_recovered', outstandingAmountPaise: 40_000, offPlatformRecoveredAmountPaise: 20_000 })).toBe(60_000)
    expect(clawbackWalletHeldPaise({ status: 'recovered', outstandingAmountPaise: 0, recoveredAmountPaise: 100_000 } as never)).toBe(0)
    expect(clawbackWalletHeldPaise({ status: 'recovered', outstandingAmountPaise: 0, offPlatformRecoveredAmountPaise: 'x' })).toBe(0)
  })
})

describe('C · clawbackArithmeticGap — a clawback must account for every paisa of its reversal exactly once', () => {
  it('consistent records (wallet-funded + outstanding + off-platform = reversal) pass, in every status', () => {
    expect(clawbackArithmeticGap({ reversalAmountPaise: 100_000, recoveredAmountPaise: 0, outstandingAmountPaise: 100_000 })).toBeNull()
    expect(clawbackArithmeticGap({ reversalAmountPaise: 100_000, recoveredAmountPaise: 0, outstandingAmountPaise: 60_000, offPlatformRecoveredAmountPaise: 40_000 })).toBeNull()
    expect(clawbackArithmeticGap({ reversalAmountPaise: 100_000, recoveredAmountPaise: 60_000, outstandingAmountPaise: 0, offPlatformRecoveredAmountPaise: 40_000 })).toBeNull()
  })
  it('a paisa counted twice, or missing, or an unreadable part is reported', () => {
    expect(clawbackArithmeticGap({ reversalAmountPaise: 100_000, recoveredAmountPaise: 60_000, outstandingAmountPaise: 0, offPlatformRecoveredAmountPaise: 41_000 })).toEqual({ expected: 100_000, actual: 101_000 })
    expect(clawbackArithmeticGap({ reversalAmountPaise: 100_000, recoveredAmountPaise: 40_000, outstandingAmountPaise: 60_000, offPlatformRecoveredAmountPaise: 40_000 })).toEqual({ expected: 100_000, actual: 140_000 })
    expect(clawbackArithmeticGap({ reversalAmountPaise: 100_000, recoveredAmountPaise: 0, outstandingAmountPaise: 50_000 })).toEqual({ expected: 100_000, actual: 50_000 })
    expect(clawbackArithmeticGap({ reversalAmountPaise: 9_000, recoveredAmountPaise: 0, outstandingAmountPaise: 'nine thousand' })).toEqual({ expected: 9_000, actual: -1 })
    expect(clawbackArithmeticGap({ reversalAmountPaise: 9_000, recoveredAmountPaise: 0, outstandingAmountPaise: 9_000, offPlatformRecoveredAmountPaise: -1 })).toEqual({ expected: 9_000, actual: -1 })
  })
})

describe('F · bounded queues', () => {
  it('the registration queue attempt cap is finite; the attempt-sweep check backoff doubles from 2 min and caps at 1 h', () => {
    expect(REFUND_QUEUE_MAX_ATTEMPTS).toBeGreaterThan(1)
    expect(Number.isFinite(REFUND_QUEUE_MAX_ATTEMPTS)).toBe(true)
    expect([1, 2, 3].map(attemptCheckBackoffMs)).toEqual([2, 4, 8].map(m => m * 60_000))
    expect(attemptCheckBackoffMs(40)).toBe(60 * 60_000)
  })
  it('permanent errors escalate at once; transient ones retry', () => {
    expect(isPermanentRefundQueueError('REVERSAL_BUCKET_UNKNOWN:ptx_x:undefined')).toBe(true)
    expect(isPermanentRefundQueueError('DEADLINE_EXCEEDED')).toBe(false)
    expect(isPermanentRefundQueueError('waiting: not_reversed')).toBe(false)
    expect(isPermanentAccountingError('REFUND_HISTORY_TOO_LARGE:d1')).toBe(true)
  })
})
