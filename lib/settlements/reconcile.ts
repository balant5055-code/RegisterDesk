// Settlement-hold reconciliation after a refund reduces an organizer's available revenue balance below the
// amount reserved for open settlement requests. Server-only.
//
// M1 (payout/refund integrity) — SUPERSEDED. This used to AUTO-REJECT the now-unbacked requests after the
// refund committed (best-effort, fire-and-forget audit). The approved policy is manual review, and the refund
// paths now route unbacked requests to review INSIDE the refund transaction (lib/settlements/payoutReview.ts).
// The entry point is kept for existing importers and as a recovery re-check: it delegates to the review-based
// re-plan, so no code path can auto-reject a payout request.

import { recheckPayoutReservations } from './payoutReview'

/**
 * Re-checks an organizer's payout reservations against the CURRENT available balance and routes any request
 * that no longer fits to review (one transaction; idempotent). Returns the requests sent to review.
 */
export async function reconcileSettlementHoldsAfterRefund(
  organizerUid: string,
): Promise<{ organizerUid: string; reviewed: Array<{ id: string; amountPaise: number }> }> {
  const r = await recheckPayoutReservations(organizerUid, { kind: 'manual_recheck', ref: `recheck_${Date.now()}` })
  return { organizerUid: r.organizerUid, reviewed: r.reviewed }
}
