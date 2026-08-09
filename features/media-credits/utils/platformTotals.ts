// MC-08 · Platform aggregate arithmetic — PURE. No Firestore, no I/O.
//
// Extracted so the figures an operator reads on a financial dashboard are provable by unit
// test rather than by squinting at a rendered page. Same discipline as `ledgerMath` and
// `refundMath`.
//
// ═══ WHY A BOUNDED SCAN AT ALL ═══════════════════════════════════════════════
// Firestore can COUNT documents server-side but cannot SUM a field. Platform totals therefore
// require reading the documents. The alternatives were a rollup counter maintained inside
// every settlement transaction (a new hot document, and a change to a frozen financial path)
// or a scheduled snapshot (stale, and more work inside a financial cron). A bounded scan was
// chosen because it is exact below its cap and VISIBLY partial above it — the one option
// that never reports a confident wrong total.

import type { CreditWalletDoc, CreditPurchaseDoc } from '@/features/media-credits/types'

export interface PlatformCreditTotals {
  organizers:       number
  /** Every credit ever added across all wallets — purchases and grants. */
  creditsIssued:    number
  /** Every credit ever spent. */
  creditsConsumed:  number
  /** Currently held by open sessions. Committed but not yet charged. */
  creditsHeld:      number
  /**
   * Credits owned and not yet spent, across the platform.
   *
   * This is the LIABILITY: credits an organizer has paid for and can still use. It is
   * `Σ balance`, not `issued − consumed` — those differ once a refund debits a balance
   * without reducing `lifetimeConsumed`, and only the balance sum is the real obligation.
   */
  outstandingLiability: number
}

/**
 * Sums wallet documents.
 *
 * Reads the stored lifetime fields rather than re-deriving them from the ledger. The wallet
 * is the cache those figures live in precisely so nobody has to page a ledger to add them up.
 */
export function totalWallets(wallets: readonly CreditWalletDoc[]): PlatformCreditTotals {
  let creditsIssued = 0, creditsConsumed = 0, creditsHeld = 0, outstandingLiability = 0

  for (const w of wallets) {
    // Defensive: a corrupt field must not silently poison a platform total with NaN. A
    // skipped wallet under-reports, which is visible; NaN makes the whole figure unusable.
    creditsIssued        += finite(w.lifetimeGranted)
    creditsConsumed      += finite(w.lifetimeConsumed)
    creditsHeld          += finite(w.heldCredits)
    outstandingLiability += finite(w.balance)
  }

  return {
    organizers: wallets.length,
    creditsIssued, creditsConsumed, creditsHeld, outstandingLiability,
  }
}

export interface PlatformRevenueTotals {
  /** Purchases that actually completed. Pending and failed are excluded from money figures. */
  purchasesGranted:  number
  revenuePaise:      number
  creditsSold:       number
  /** Null when nothing has been sold — an average of zero purchases is not zero. */
  averagePurchasePaise: number | null
  /** Purchases captured but not yet granted. Each is a debt to an organizer. */
  purchasesPending:  number
  purchasesFailed:   number
}

/**
 * Sums purchase documents.
 *
 * Only `granted` purchases contribute to revenue. A `pending` one may never be paid and a
 * `paid` one has been captured but not yet turned into credits — counting either as revenue
 * would overstate what the platform has actually earned.
 */
export function totalPurchases(
  purchases: readonly CreditPurchaseDoc[],
): PlatformRevenueTotals {
  let revenuePaise = 0, creditsSold = 0, granted = 0, pending = 0, failed = 0

  for (const p of purchases) {
    if (p.status === 'granted') {
      granted++
      revenuePaise += finite(p.amountPaise)
      creditsSold  += finite(p.credits)
    } else if (p.status === 'failed') {
      failed++
    } else {
      // `pending` and `paid` alike — money not yet converted into credits.
      pending++
    }
  }

  return {
    purchasesGranted: granted,
    revenuePaise, creditsSold,
    averagePurchasePaise: granted > 0 ? Math.round(revenuePaise / granted) : null,
    purchasesPending: pending,
    purchasesFailed:  failed,
  }
}

/** Average credits consumed per photo across the platform, or null when nothing was used. */
export function averageCreditsPerUpload(
  creditsConsumed: number, photosUploaded: number | null,
): number | null {
  if (photosUploaded === null || photosUploaded <= 0) return null
  return Number((creditsConsumed / photosUploaded).toFixed(2))
}

/** A non-finite stored value contributes nothing rather than making the whole sum NaN. */
function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
