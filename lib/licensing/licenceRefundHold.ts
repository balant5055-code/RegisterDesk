// RD-SA-COMMERCE-P1 (P1-1 / P1-2 / PD-2) · the rules for a licence refund hold — PURE, no I/O.
//
// A licence refund claims the licence (`eventLicenses/{slug}.refundHold`) before any money moves.
// The hold carries the claiming ATTEMPT and its PHASE:
//   claimed     — the claim committed; nothing has been sent to the gateway yet
//   gateway     — the attempt passed its fence and is (or was) calling the gateway
//   unknown     — the gateway call failed and its outcome could NOT be established: held for reconciliation
//   completing  — a Super Admin is completing a refund whose money is known to have moved
//   reconcile   — the money moved and the licence was cancelled, but the internal finalization (order,
//                 held units, coupon use) did not complete: only `completeRefund` may finish it (H2)
//
// Every write that ends a hold is an atomic transition re-checked inside a transaction against the
// attempt it read, so a stale actor can never act on a newer attempt's hold.
//
// PD-2 — a hold may be RELEASED (money confirmed NOT to have moved) only once it is at least
// REFUND_HOLD_MIN_RELEASE_AGE_MS old. Age is necessary, never sufficient: the release must also see
// the gateway report no refund, no wallet credit-back, and an order that was not finalized. An
// ambiguous gateway answer keeps the hold.

/** PD-2 — minimum hold age before a release may even be considered. Longer than any refund request
 *  can live (the admin licence route pins maxDuration well below it). */
export const REFUND_HOLD_MIN_RELEASE_AGE_MS = 15 * 60 * 1000

export type RefundHoldPhase = 'claimed' | 'gateway' | 'unknown' | 'completing' | 'reconcile'

/**
 * H1 — does a failed refund call PROVE that no refund was created? Only a structured gateway response
 * says so: the Razorpay SDK rethrows an API error response as `{ statusCode, error: { code, … } }`
 * (node_modules/razorpay/dist/api.js normalizeError). A timeout, connection reset or any failure with no
 * response surfaces differently (no `statusCode`), and a 5xx / 408 / 409 / 429 is not a rejection of the
 * refund either — none of those is proof, so none of them may undo a claim. The SDK offers no refund
 * idempotency key, so nothing here relies on one.
 */
const DEFINITIVE_REJECTION_STATUS: ReadonlySet<number> = new Set([400, 401, 403, 404, 422])
export function isDefinitiveGatewayRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object' || err instanceof Error) return false
  const e = err as { statusCode?: unknown; error?: unknown }
  if (typeof e.statusCode !== 'number' || !DEFINITIVE_REJECTION_STATUS.has(e.statusCode)) return false
  const body = e.error as { code?: unknown } | null | undefined
  return !!body && typeof body === 'object' && typeof body.code === 'string' && body.code.length > 0
}

/** A readable message for a gateway failure (SDK error objects are not Error instances). */
export function gatewayErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  const d = (err as { error?: { description?: unknown } } | null)?.error?.description
  return typeof d === 'string' && d ? d : 'unknown error'
}

/** Old enough to be considered for release or a takeover? A hold with no readable time is legacy: old. */
export function refundHoldOldEnough(atMs: number | null, nowMs: number): boolean {
  return atMs === null || nowMs - atMs >= REFUND_HOLD_MIN_RELEASE_AGE_MS
}

/**
 * What the gateway's own refund list says happened to a payment:
 *   unknown — the list could not be read (or was malformed): NOTHING may be concluded
 *   none    — no refund exists (failed refunds count as none)
 *   full    — non-failed refunds cover at least `expectedPaise`
 *   partial — some money was refunded, but less than `expectedPaise`: a human must reconcile
 */
export type GatewayRefundOutcome =
  | { kind: 'unknown' }
  | { kind: 'none' }
  | { kind: 'full'; refundedPaise: number; refundIds: string[] }
  | { kind: 'partial'; refundedPaise: number; refundIds: string[] }

export function classifyGatewayRefunds(list: unknown, expectedPaise: number): GatewayRefundOutcome {
  const items = (list as { items?: unknown } | null | undefined)?.items
  if (!Array.isArray(items)) return { kind: 'unknown' }
  let refundedPaise = 0
  const refundIds: string[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') return { kind: 'unknown' }
    const r = raw as { id?: unknown; status?: unknown; amount?: unknown }
    if (r.status === 'failed') continue
    // A non-failed refund with no readable amount cannot be sized: unknown, never "none".
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount < 0) return { kind: 'unknown' }
    refundedPaise += r.amount
    if (typeof r.id === 'string') refundIds.push(r.id)
  }
  if (refundedPaise === 0 && refundIds.length === 0) return { kind: 'none' }
  return refundedPaise >= expectedPaise
    ? { kind: 'full', refundedPaise, refundIds }
    : { kind: 'partial', refundedPaise, refundIds }
}
