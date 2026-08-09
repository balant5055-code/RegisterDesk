// MC-08 · Platform aggregate arithmetic. Pure — no Firestore.
//
// These are the figures an operator reads to answer "what does the platform owe". Worth
// asserting directly rather than trusting a rendered dashboard.

import { describe, it, expect } from 'vitest'
import {
  averageCreditsPerUpload, totalPurchases, totalWallets,
} from '@/features/media-credits/utils/platformTotals'
import type { CreditPurchaseDoc, CreditWalletDoc } from '@/features/media-credits/types'

const wallet = (p: Partial<CreditWalletDoc>): CreditWalletDoc => ({
  organizerUid: 'u', schemaVersion: 1,
  balance: 0, heldCredits: 0, lifetimeGranted: 0, lifetimeConsumed: 0,
  updatedAt: null, ...p,
} as CreditWalletDoc)

const purchase = (p: Partial<CreditPurchaseDoc>): CreditPurchaseDoc => ({
  purchaseId: 'p', status: 'granted', credits: 0, amountPaise: 0, ...p,
} as CreditPurchaseDoc)

describe('totalWallets', () => {
  it('sums across every wallet', () => {
    const t = totalWallets([
      wallet({ balance: 100, heldCredits: 10, lifetimeGranted: 500, lifetimeConsumed: 400 }),
      wallet({ balance: 250, heldCredits: 0,  lifetimeGranted: 300, lifetimeConsumed: 50 }),
    ])
    expect(t.organizers).toBe(2)
    expect(t.creditsIssued).toBe(800)
    expect(t.creditsConsumed).toBe(450)
    expect(t.creditsHeld).toBe(10)
    expect(t.outstandingLiability).toBe(350)
  })

  it('liability is the sum of BALANCES, not issued minus consumed', () => {
    // The two diverge once a refund debits a balance without touching lifetimeConsumed.
    // Only the balance sum is what the platform actually owes.
    const t = totalWallets([
      wallet({ balance: 40, lifetimeGranted: 100, lifetimeConsumed: 50 }),
    ])
    expect(t.outstandingLiability).toBe(40)
    expect(t.creditsIssued - t.creditsConsumed).toBe(50)   // deliberately different
  })

  it('an empty platform totals zero, not NaN', () => {
    const t = totalWallets([])
    expect(t).toEqual({
      organizers: 0, creditsIssued: 0, creditsConsumed: 0,
      creditsHeld: 0, outstandingLiability: 0,
    })
  })

  it('a corrupt field contributes nothing rather than poisoning the total', () => {
    // One bad document must not make every figure on the dashboard NaN.
    const t = totalWallets([
      wallet({ balance: 100 }),
      wallet({ balance: 'oops' as unknown as number, lifetimeGranted: NaN }),
    ])
    expect(t.outstandingLiability).toBe(100)
    expect(Number.isFinite(t.creditsIssued)).toBe(true)
  })
})

describe('totalPurchases', () => {
  it('counts only GRANTED purchases as revenue', () => {
    const t = totalPurchases([
      purchase({ status: 'granted', credits: 100, amountPaise: 10_000 }),
      purchase({ status: 'granted', credits: 50,  amountPaise: 5_000 }),
      // Captured but not yet converted into credits — not earned yet.
      purchase({ status: 'paid',    credits: 999, amountPaise: 99_900 }),
      purchase({ status: 'pending', credits: 999, amountPaise: 99_900 }),
      purchase({ status: 'failed',  credits: 999, amountPaise: 99_900 }),
    ])
    expect(t.revenuePaise).toBe(15_000)
    expect(t.creditsSold).toBe(150)
    expect(t.purchasesGranted).toBe(2)
    expect(t.purchasesPending).toBe(2)    // paid + pending
    expect(t.purchasesFailed).toBe(1)
  })

  it('average purchase is null with no sales, never zero', () => {
    expect(totalPurchases([]).averagePurchasePaise).toBeNull()
    expect(totalPurchases([purchase({ status: 'failed' })]).averagePurchasePaise).toBeNull()
  })

  it('averages over granted purchases only', () => {
    const t = totalPurchases([
      purchase({ status: 'granted', amountPaise: 10_000 }),
      purchase({ status: 'granted', amountPaise: 20_000 }),
      purchase({ status: 'pending', amountPaise: 999_999 }),
    ])
    expect(t.averagePurchasePaise).toBe(15_000)
  })
})

describe('averageCreditsPerUpload', () => {
  it('divides consumed credits by photos', () => {
    expect(averageCreditsPerUpload(1000, 500)).toBe(2)
  })

  it('is null when the photo count is unknown — no approximation', () => {
    expect(averageCreditsPerUpload(1000, null)).toBeNull()
  })

  it('is null rather than dividing by zero', () => {
    expect(averageCreditsPerUpload(1000, 0)).toBeNull()
  })
})
