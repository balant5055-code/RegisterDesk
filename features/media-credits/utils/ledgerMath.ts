// MC-02 · Ledger arithmetic and validation — PURE.
//
// Extracted from the service so every rule below is unit-testable in this repo's `node`
// vitest environment. Anything importing `lib/firebase/admin` cannot be loaded by a test
// file here, so the decisions live apart from the I/O that applies them — the same split
// used by `snapshotScheduler.ts` and `draftRenderSync.ts`.
//
// ═══ THE INVARIANT THIS FILE DEFENDS ═════════════════════════════════════════
//   balance ≡ Σ ledger.delta                                the ledger is truth
//   available = balance − heldCredits − refundHeldCredits   only `available` funds a debit
//
// RD-MC-REFUND-V2-P3 added the second hold. `availableCredits` is deliberately the ONLY
// definition of spendability in the module, and it has exactly two consumers — the
// `openSession` exactness gate and `applyDelta`'s debit guard. That is why one edit here
// makes an upload unable to consume credits reserved by a pending refund AND a second refund
// unable to double-spend them, with no new rule written anywhere.

import { InsufficientCreditsError, InvalidCreditOperationError } from '@/features/media-credits/errors'
import type { CreditLedgerReason, CreditWalletDoc } from '@/features/media-credits/types'

/** The wallet fields the arithmetic needs. Narrower than the document on purpose. */
export interface WalletBalances {
  balance:          number
  /** Locked by open upload sessions. */
  heldCredits:      number
  /** RD-MC-REFUND-V2-P3 · locked by pending refund requests. */
  refundHeldCredits: number
  lifetimeGranted:  number
  lifetimeConsumed: number
}

export const ZERO_BALANCES: WalletBalances = {
  balance: 0, heldCredits: 0, refundHeldCredits: 0,
  lifetimeGranted: 0, lifetimeConsumed: 0,
}

/**
 * Spendable credits. The ONLY figure a debit may be checked against.
 *
 * Both holds subtract. A credit reserved by a pending refund is as unspendable as one
 * reserved by an in-flight upload — the organizer has asked for it back, and letting a photo
 * consume it would either overdraw the wallet or make the refund unpayable.
 *
 * Never negative: two holds that together exceed the balance would otherwise make `available`
 * negative and every comparison against it behave backwards. Reaching zero is the correct
 * failure — nothing is spendable — and I5/I6 are checked against real documents in the
 * emulator suite rather than papered over here.
 */
export function availableCredits(
  w: Pick<WalletBalances, 'balance' | 'heldCredits' | 'refundHeldCredits'>,
): number {
  return Math.max(0, w.balance - w.heldCredits - (w.refundHeldCredits ?? 0))
}

/**
 * Reasons whose delta must be positive, negative, or exactly zero.
 *
 * `release` is zero because returning a hold moves no credits — the hold never left the
 * balance. It is recorded so the ledger explains `heldCredits` history, not just `balance`.
 */
const SIGN_BY_REASON: Record<CreditLedgerReason, 'positive' | 'negative' | 'zero' | 'any'> = {
  purchase:   'positive',
  grant:      'positive',
  consume:    'negative',
  refund:     'negative',
  release:    'zero',
  adjustment: 'any',      // platform correction: may go either way, never zero
}

/**
 * Rejects a delta that could never be valid, before any Firestore work.
 *
 * Credits are indivisible, so a fractional delta is a bug rather than a rounding question.
 */
export function assertValidDelta(delta: number, reason: CreditLedgerReason): void {
  if (!Number.isFinite(delta) || !Number.isInteger(delta)) {
    throw new InvalidCreditOperationError(`delta must be an integer, received ${String(delta)}`)
  }
  const expected = SIGN_BY_REASON[reason]
  if (expected === undefined) {
    throw new InvalidCreditOperationError(`unknown reason "${String(reason)}"`)
  }
  if (expected === 'zero' && delta !== 0) {
    throw new InvalidCreditOperationError(`reason "${reason}" requires delta 0, received ${delta}`)
  }
  if (expected === 'positive' && delta <= 0) {
    throw new InvalidCreditOperationError(`reason "${reason}" requires a positive delta, received ${delta}`)
  }
  if (expected === 'negative' && delta >= 0) {
    throw new InvalidCreditOperationError(`reason "${reason}" requires a negative delta, received ${delta}`)
  }
  if (expected === 'any' && delta === 0) {
    throw new InvalidCreditOperationError(`reason "${reason}" requires a non-zero delta`)
  }
}

/**
 * The wallet state after applying one entry.
 *
 * Pure: same inputs, same output, no clock and no I/O. The caller persists the result inside
 * a transaction; this function never decides *when* that happens.
 *
 * A debit is checked against `available`, not `balance`, so held credits can never be spent
 * twice. Overdraft raises `InsufficientCreditsError` rather than clamping — silently
 * charging less than requested would be worse than refusing.
 */
export function applyDelta(
  current: WalletBalances,
  delta: number,
  reason: CreditLedgerReason,
): WalletBalances {
  assertValidDelta(delta, reason)

  if (delta < 0) {
    const spendable = availableCredits(current)
    const required  = Math.abs(delta)
    if (required > spendable) throw new InsufficientCreditsError(required, spendable)
  }

  return {
    balance:     current.balance + delta,
    heldCredits: current.heldCredits,          // MC-02 never moves holds
    // Nor this one. A movement and a hold are separate operations, and the caller that needs
    // both — `approveRefund` — frees the hold FIRST and passes the freed balances in. Moving
    // it here would make that ordering invisible and un-testable.
    refundHeldCredits: current.refundHeldCredits,
    // Lifetime totals are monotonic counters, not balances: they only ever increase, so a
    // refund does NOT decrease lifetimeGranted. They answer "how much has ever flowed",
    // which a balance cannot.
    lifetimeGranted:  current.lifetimeGranted  + (delta > 0 ? delta : 0),
    lifetimeConsumed: current.lifetimeConsumed + (delta < 0 ? -delta : 0),
  }
}

/** Recomputes a balance from ledger deltas — the reconciliation the cache is checked against. */
export function balanceFromDeltas(deltas: readonly number[]): number {
  return deltas.reduce((sum, d) => sum + d, 0)
}

/** Wallet balances from a document, or zeros when the workspace has never held credits. */
export function balancesOf(wallet: CreditWalletDoc | null): WalletBalances {
  if (!wallet) return { ...ZERO_BALANCES }
  return {
    balance:          wallet.balance,
    heldCredits:      wallet.heldCredits,
    // RD-MC-REFUND-V2-P3 · absent before P3. A wallet without the field has no pending refund
    // hold, so zero is the right reading and no migration is needed.
    refundHeldCredits: wallet.refundHeldCredits ?? 0,
    lifetimeGranted:  wallet.lifetimeGranted,
    lifetimeConsumed: wallet.lifetimeConsumed,
  }
}
