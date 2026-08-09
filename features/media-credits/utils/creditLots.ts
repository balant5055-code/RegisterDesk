// RD-MC-REFUND-V2-P1 · FIFO attribution of consumption to credit lots — PURE.
//
// ═══ WHAT A LOT IS ════════════════════════════════════════════════════════════
// Every credit in a wallet arrived from exactly one of two places: a PURCHASE or a GRANT.
// Each is a "lot" — a batch of credits with an arrival time and a remaining count.
//
// The wallet stays a single pooled balance; nothing about it changes. Lots are a parallel
// record of WHERE the balance came from, which is the one question the ledger cannot answer:
// a `consume` entry carries no purchaseId, and it never could — a session spends the wallet,
// not a batch.
//
// ═══ THE INVARIANT ════════════════════════════════════════════════════════════
//     Σ purchase.creditsRemaining + Σ grant.creditsRemaining == wallet.balance
//
// Against BALANCE, not `available`. `available` is `balance − held`, and a session's hold
// consumes availability before anything is settled — so during any in-flight upload the sum
// legitimately exceeds it. Grants are lots for the same reason: without them the sum is
// permanently short by every credit ever granted, and an auditor could not tell a granted
// credit from an attribution error.
//
// PURE. Firestore I/O lives in repositories/lotRepo.ts.

/** One batch of credits, as the allocator needs to see it. */
export interface CreditLot {
  /** Purchase id or grant id. Unique within its kind. */
  lotId:  string
  kind:   'purchase' | 'grant'
  /** When the credits landed. FIFO order. */
  seq:    number
  /** Credits still unspent in this lot. */
  remaining: number
}

/** How much to take from one lot. */
export interface LotDebit {
  lotId:  string
  kind:   'purchase' | 'grant'
  /** Credits taken. Always > 0. */
  credits: number
  /** What the lot holds afterwards. */
  remainingAfter: number
}

export interface AllocationResult {
  debits: LotDebit[]
  /**
   * Credits that could not be attributed to any lot.
   *
   * Non-zero means the lots and the wallet disagree — the balance covered the consumption
   * but no lot did. The caller must treat it as a defect to surface, never as a rounding
   * detail: it is exactly the drift this feature exists to make visible.
   */
  unattributed: number
}

/**
 * Spends `credits` across lots, oldest first.
 *
 * Never skips an older lot and never takes more than a lot holds. A lot that reaches zero is
 * simply drained — the caller decides what that means for storage (see `lotRepo`, which
 * clears the ordering key so a drained lot leaves the query entirely).
 *
 * Deliberately total: given any input it returns a decision rather than throwing, and reports
 * the shortfall through `unattributed` so the caller can decide how loudly to fail. Throwing
 * here would abort a settlement transaction that has already released a hold correctly.
 */
export function allocateFifo(
  lots: readonly CreditLot[], credits: number,
): AllocationResult {
  const want = Math.max(0, Math.trunc(credits))
  if (want === 0) return { debits: [], unattributed: 0 }

  // Sorted here rather than trusted from the query: a caller reading two collections and
  // concatenating them has no single index to order by, so the merge happens where it can be
  // tested. Ties break on lotId so the result is deterministic.
  const ordered = [...lots]
    .filter(l => safe(l.remaining) > 0)
    .sort((a, b) => (a.seq - b.seq) || a.lotId.localeCompare(b.lotId))

  const debits: LotDebit[] = []
  let left = want

  for (const lot of ordered) {
    if (left === 0) break
    const available = safe(lot.remaining)
    const take = Math.min(available, left)
    if (take <= 0) continue

    debits.push({
      lotId: lot.lotId,
      kind:  lot.kind,
      credits: take,
      remainingAfter: available - take,
    })
    left -= take
  }

  return { debits, unattributed: left }
}

/** Σ remaining across lots. The left-hand side of the invariant. */
export function totalRemaining(lots: readonly CreditLot[]): number {
  return lots.reduce((n, l) => n + safe(l.remaining), 0)
}

/**
 * Returns the lot a refund of one purchase should reduce, and by how much.
 *
 * Whole-purchase refunds (the only kind today) drain the lot completely. Expressed as its own
 * function so Phase 2's partial refunds have one place to change, rather than the arithmetic
 * being inlined at the refund call site.
 */
export function refundDebitFor(
  lot: CreditLot | null, creditsRefunded: number,
): LotDebit | null {
  if (!lot) return null
  const take = Math.min(safe(lot.remaining), Math.max(0, Math.trunc(creditsRefunded)))
  if (take <= 0) return null
  return {
    lotId: lot.lotId, kind: lot.kind, credits: take,
    remainingAfter: safe(lot.remaining) - take,
  }
}

/** A stored number that cannot be trusted contributes 0 rather than NaN to the arithmetic. */
function safe(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0
}
