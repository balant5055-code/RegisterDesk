// MC-02 — the credit invariants, tested where they are decided.
//
// These exercise `utils/ledgerMath.ts`, which is pure. The services and repositories import
// `lib/firebase/admin`, which cannot be loaded in this repo's `node` vitest environment —
// so the RULES were extracted there precisely to keep them testable. What these tests
// cannot cover (transaction atomicity, real concurrency) is called out in the MC-02 report
// rather than faked with a mock that would prove nothing.
//
// The invariants under test:
//   balance ≡ Σ ledger.delta
//   available = balance − heldCredits, and only `available` may fund a debit

import { describe, it, expect } from 'vitest'
import {
  applyDelta, assertValidDelta, availableCredits, balanceFromDeltas, balancesOf,
  ZERO_BALANCES, type WalletBalances,
} from '@/features/media-credits/utils/ledgerMath'
import {
  InsufficientCreditsError, InvalidCreditOperationError,
} from '@/features/media-credits/errors'
import type { CreditWalletDoc } from '@/features/media-credits/types'

const w = (over: Partial<WalletBalances> = {}): WalletBalances => ({ ...ZERO_BALANCES, ...over })

describe('wallet creation is lazy — absence reads as zero, not as an error', () => {
  it('a missing wallet yields zero balances', () => {
    expect(balancesOf(null)).toEqual(ZERO_BALANCES)
  })

  it('an existing wallet is read verbatim', () => {
    const doc = {
      balance: 40, heldCredits: 5, refundHeldCredits: 12,
      lifetimeGranted: 100, lifetimeConsumed: 60,
    } as CreditWalletDoc
    expect(balancesOf(doc)).toEqual({
      balance: 40, heldCredits: 5, refundHeldCredits: 12,
      lifetimeGranted: 100, lifetimeConsumed: 60,
    })
  })

  it('RD-MC-REFUND-V2-P3 · a wallet written before P3 reads its refund hold as ZERO', () => {
    // No field means no pending refund hold, which is the correct reading — so no migration
    // is needed and a pre-P3 wallet behaves exactly as it did.
    const doc = {
      balance: 40, heldCredits: 5, lifetimeGranted: 100, lifetimeConsumed: 60,
    } as CreditWalletDoc
    expect(balancesOf(doc).refundHeldCredits).toBe(0)
    expect(availableCredits(balancesOf(doc))).toBe(35)
  })
})

// ─── RD-MC-REFUND-V2-P3 · the second hold ─────────────────────────────────────
//
// INVARIANT I6: available = balance − heldCredits − refundHeldCredits.
//
// `availableCredits` has exactly two consumers — the openSession gate and applyDelta's debit
// guard — so these cases are the whole of "an upload cannot spend credits a refund reserved"
// and "a second refund cannot double-spend the first one's reservation".

describe('availableCredits with both holds', () => {
  it('subtracts BOTH holds', () => {
    expect(availableCredits(w({ balance: 500, heldCredits: 40, refundHeldCredits: 100 })))
      .toBe(360)
  })

  it('a refund hold alone reduces availability — the P3 workflow', () => {
    // Purchase 500, one credit used, 499 refundable. On request: balance unchanged,
    // available down by 499.
    const held = w({ balance: 499, refundHeldCredits: 499 })
    expect(held.balance).toBe(499)
    expect(availableCredits(held)).toBe(0)
  })

  it('NEVER goes negative, even when the holds exceed the balance', () => {
    // Every comparison against `available` is a `>` or `<`; a negative would make them
    // behave backwards. Zero is the correct failure — nothing is spendable.
    expect(availableCredits(w({ balance: 10, heldCredits: 40, refundHeldCredits: 100 })))
      .toBe(0)
  })
})

describe('a debit is checked against BOTH holds', () => {
  it('refuses a debit that a refund hold has reserved', () => {
    // An upload settling for 100 against a wallet whose 500 is entirely refund-held.
    expect(() => applyDelta(w({ balance: 500, refundHeldCredits: 500 }), -100, 'consume'))
      .toThrow(InsufficientCreditsError)
  })

  it('allows exactly what is left over after both holds', () => {
    const wallet = w({ balance: 500, heldCredits: 100, refundHeldCredits: 300 })
    expect(applyDelta(wallet, -100, 'consume').balance).toBe(400)
    expect(() => applyDelta(wallet, -101, 'consume')).toThrow(InsufficientCreditsError)
  })

  it('a movement NEVER moves either hold — that is the caller’s job', () => {
    // `approveRefund` frees its hold before the debit, and it must be able to see that
    // happening. Folding it in here would make the ordering invisible.
    const next = applyDelta(w({ balance: 500, heldCredits: 40, refundHeldCredits: 100 }), -50, 'refund')
    expect(next.heldCredits).toBe(40)
    expect(next.refundHeldCredits).toBe(100)
  })
})

describe('credit (positive delta)', () => {
  it('increases balance and lifetimeGranted, never lifetimeConsumed', () => {
    const next = applyDelta(w(), 25, 'purchase')
    expect(next.balance).toBe(25)
    expect(next.lifetimeGranted).toBe(25)
    expect(next.lifetimeConsumed).toBe(0)
  })

  it('leaves heldCredits untouched — MC-02 never moves holds', () => {
    expect(applyDelta(w({ heldCredits: 7 }), 10, 'grant').heldCredits).toBe(7)
  })
})

describe('debit (negative delta)', () => {
  it('decreases balance and increases lifetimeConsumed', () => {
    const next = applyDelta(w({ balance: 50, lifetimeGranted: 50 }), -20, 'consume')
    expect(next.balance).toBe(30)
    expect(next.lifetimeConsumed).toBe(20)
    // Monotonic counters: consuming does not reduce what was ever granted.
    expect(next.lifetimeGranted).toBe(50)
  })

  it('a refund also reduces balance and counts as consumed', () => {
    const next = applyDelta(w({ balance: 10 }), -10, 'refund')
    expect(next.balance).toBe(0)
    expect(next.lifetimeConsumed).toBe(10)
  })
})

describe('overdraft is refused, never clamped', () => {
  it('rejects a debit larger than the balance', () => {
    expect(() => applyDelta(w({ balance: 5 }), -6, 'consume'))
      .toThrow(InsufficientCreditsError)
  })

  it('checks AVAILABLE, not balance — held credits cannot be spent', () => {
    // 10 owned, 8 held ⇒ 2 spendable. A debit of 3 must fail even though balance is 10.
    const wallet = w({ balance: 10, heldCredits: 8 })
    expect(availableCredits(wallet)).toBe(2)
    expect(() => applyDelta(wallet, -3, 'consume')).toThrow(InsufficientCreditsError)
    expect(applyDelta(wallet, -2, 'consume').balance).toBe(8)
  })

  it('carries required and available so the caller need not re-read', () => {
    try {
      applyDelta(w({ balance: 4, heldCredits: 1 }), -10, 'consume')
      expect.unreachable('should have thrown')
    } catch (e) {
      const err = e as InsufficientCreditsError
      expect(err.code).toBe('INSUFFICIENT_CREDITS')
      expect(err.required).toBe(10)
      expect(err.available).toBe(3)
    }
  })

  it('spending exactly the available amount is allowed', () => {
    expect(applyDelta(w({ balance: 10, heldCredits: 4 }), -6, 'consume').balance).toBe(4)
  })
})

describe('delta validation — a bad operation never reaches Firestore', () => {
  it('rejects non-integers: credits are indivisible', () => {
    expect(() => assertValidDelta(1.5, 'purchase')).toThrow(InvalidCreditOperationError)
  })

  it('rejects NaN and Infinity', () => {
    expect(() => assertValidDelta(Number.NaN, 'purchase')).toThrow(InvalidCreditOperationError)
    expect(() => assertValidDelta(Number.POSITIVE_INFINITY, 'purchase')).toThrow(InvalidCreditOperationError)
  })

  it('enforces the sign each reason requires', () => {
    expect(() => assertValidDelta(-5, 'purchase')).toThrow(InvalidCreditOperationError)
    expect(() => assertValidDelta(5,  'consume')).toThrow(InvalidCreditOperationError)
    expect(() => assertValidDelta(0,  'grant')).toThrow(InvalidCreditOperationError)
  })

  it('release must be exactly zero — a hold never left the balance', () => {
    expect(() => assertValidDelta(0, 'release')).not.toThrow()
    expect(() => assertValidDelta(-1, 'release')).toThrow(InvalidCreditOperationError)
    expect(() => assertValidDelta(1,  'release')).toThrow(InvalidCreditOperationError)
  })

  it('adjustment may go either way but never nowhere', () => {
    expect(() => assertValidDelta(7,  'adjustment')).not.toThrow()
    expect(() => assertValidDelta(-7, 'adjustment')).not.toThrow()
    expect(() => assertValidDelta(0,  'adjustment')).toThrow(InvalidCreditOperationError)
  })

  it('a release leaves every figure unchanged', () => {
    const before = w({ balance: 12, heldCredits: 3, lifetimeGranted: 20, lifetimeConsumed: 8 })
    expect(applyDelta(before, 0, 'release')).toEqual(before)
  })
})

describe('THE invariant: balance ≡ Σ ledger.delta', () => {
  it('a sequence of movements reconciles against its deltas', () => {
    const deltas = [100, -30, -20, 50, -10]
    let wallet = w()
    const applied: number[] = []
    for (const d of deltas) {
      wallet = applyDelta(wallet, d, d > 0 ? 'grant' : 'consume')
      applied.push(d)
    }
    expect(wallet.balance).toBe(balanceFromDeltas(applied))
    expect(wallet.balance).toBe(90)
  })

  it('lifetime totals reconcile independently of the balance', () => {
    let wallet = w()
    for (const d of [100, -30, 50, -20]) {
      wallet = applyDelta(wallet, d, d > 0 ? 'grant' : 'consume')
    }
    expect(wallet.lifetimeGranted).toBe(150)
    expect(wallet.lifetimeConsumed).toBe(50)
    expect(wallet.balance).toBe(100)
  })
})

describe('purity — the same input always yields the same output', () => {
  it('does not mutate the wallet it is given', () => {
    const before = w({ balance: 10 })
    const snapshot = { ...before }
    applyDelta(before, 5, 'grant')
    expect(before).toEqual(snapshot)
  })

  it('repeated application is a function of its input, not of call order', () => {
    const start = w({ balance: 10 })
    expect(applyDelta(start, 5, 'grant')).toEqual(applyDelta(start, 5, 'grant'))
  })
})
