// M1 — payout requests that a refund leaves UNBACKED go to manual review (never auto-rejected, never reduced).
// Server-only.
//
// A payout request reserves its amount in wallet.inTransitPaise (held INSIDE availablePaise). When a refund
// reversal lowers availablePaise below the reserved total, the requests that no longer fit are routed to review
// IN THE SAME TRANSACTION as the refund (registration: reversePlatformTransactionAndDebit; donation:
// applyDonationRefundAccounting), so the refund, the reservations and inTransitPaise can never disagree:
//
//   • which requests keep their reservation is the existing convention: approved before pending, then oldest
//     first, greedily filling availablePaise; legacy requests without a reservation are never touched;
//   • a request that no longer fits keeps its status ('pending' / 'approved') and its FULL amount. Its
//     reservation is released (`reserved: false`) so inTransitPaise = Σ surviving reservations ≤ availablePaise
//     (the invariant and the reconciliation derivation are unchanged), and `payoutReview` (status 'open')
//     records the trigger, the amount and the balance;
//   • while a review is open the request cannot be approved or marked paid, and the organizer cannot file a new
//     request (app/api/organizer/settlements, app/api/admin/settlements/[id]);
//   • a Super Admin resolves it: resume (re-reserve, only if it fits now), reject (an approved request needs an
//     explicit confirmation that no bank transfer was made), or record a transfer that DID complete (paid; a part
//     available cannot cover becomes a 'payout_shortfall' clawback). Nothing here assumes whether a bank
//     transfer happened: RegisterDesk records transfers, it does not make them.
//   • the review opening is audited (staged in the transaction) and the organizer is notified (Notification
//     Center document written in the transaction, deterministic id).
//
// Nothing here moves money; it only changes reservations and review state.

import { FieldValue, type Transaction, type DocumentReference } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import { prepareNotification } from '@/lib/notifications/inbox/write'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import type { PayoutReviewTriggerKind, SettlementPayoutReview, SettlementRequestDoc } from './types'

/** Open requests read per organizer inside a refund transaction. More fails CLOSED (the refund retries). */
export const MAX_OPEN_PAYOUT_REQUESTS = 100

export interface OpenPayoutRequest {
  id:            string
  ref:           DocumentReference
  status:        'pending' | 'approved'
  amountPaise:   number
  reserved:      boolean
  reviewOpen:    boolean
  requestedAtMs: number
}

export interface PayoutRefitPlan {
  /** inTransitPaise after the plan: Σ reservations kept */
  keptPaise: number
  /** reserved requests that no longer fit, each with what the requests kept ahead of it already held */
  toReview:  Array<OpenPayoutRequest & { keptAheadPaise: number }>
}

function millis(t: unknown): number {
  const v = t as { toMillis?: () => number } | null
  return v && typeof v.toMillis === 'function' ? v.toMillis() : 0
}

export function toOpenPayoutRequest(id: string, ref: DocumentReference, d: SettlementRequestDoc): OpenPayoutRequest {
  return {
    id, ref,
    status:        d.status === 'approved' ? 'approved' : 'pending',
    amountPaise:   d.amountPaise,
    reserved:      d.reserved === true,
    reviewOpen:    d.payoutReview?.status === 'open',
    requestedAtMs: millis(d.requestedAt),
  }
}

/**
 * PURE — which reservations survive against `availablePaise`. Approved before pending, then oldest first, filled
 * greedily (a later, smaller request can still fit after a larger one did not). Requests without a reservation
 * (legacy, or already under review) are ignored.
 */
export function planPayoutRefit(requests: OpenPayoutRequest[], availablePaise: number): PayoutRefitPlan {
  const holds = requests.filter(r => r.reserved && !r.reviewOpen).sort((a, b) => {
    const pa = a.status === 'approved' ? 0 : 1, pb = b.status === 'approved' ? 0 : 1
    if (pa !== pb) return pa - pb
    if (a.requestedAtMs !== b.requestedAtMs) return a.requestedAtMs - b.requestedAtMs
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  let kept = 0
  const toReview: PayoutRefitPlan['toReview'] = []
  for (const h of holds) {
    if (kept + h.amountPaise <= availablePaise) kept += h.amountPaise
    else toReview.push({ ...h, keptAheadPaise: kept })
  }
  return { keptPaise: kept, toReview }
}

/** In a transaction (a READ — call before any write): the organizer's open (pending / approved) requests. */
export async function readOpenPayoutRequests(tx: Transaction, organizerUid: string): Promise<OpenPayoutRequest[]> {
  const snap = await tx.get(adminDb.collection('settlementRequests')
    .where('organizerUid', '==', organizerUid).where('status', 'in', ['pending', 'approved'])
    .limit(MAX_OPEN_PAYOUT_REQUESTS + 1))
  if (snap.size > MAX_OPEN_PAYOUT_REQUESTS) throw new Error(`PAYOUT_REQUESTS_TOO_MANY:${organizerUid}`)
  return snap.docs.map(d => toOpenPayoutRequest(d.id, d.ref, d.data() as SettlementRequestDoc))
}

export interface PayoutReviewTrigger { kind: PayoutReviewTriggerKind; ref: string }

/** Deterministic, Firestore-safe id fragment for one trigger. */
const idPart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)

/**
 * In a transaction (WRITES — after every read): open a review on each request of `plan.toReview`, staging its
 * audit row and organizer notification in the same transaction. The caller writes inTransitPaise = plan.keptPaise.
 * Deterministic audit / notification ids per (request, trigger): a retried transaction rewrites, never duplicates.
 */
export function stagePayoutReviews(tx: Transaction, input: {
  organizerUid: string; availablePaise: number; trigger: PayoutReviewTrigger; plan: PayoutRefitPlan
}): void {
  for (const r of input.plan.toReview) {
    const review: SettlementPayoutReview = {
      status: 'open', reason: 'available_below_reservations', trigger: input.trigger, openedAt: FieldValue.serverTimestamp(),
      statusAtReview: r.status, requestedAmountPaise: r.amountPaise,
      availableAtReviewPaise: input.availablePaise, keptAheadPaise: r.keptAheadPaise,
    }
    tx.update(r.ref, { reserved: false, payoutReview: review, updatedAt: FieldValue.serverTimestamp() })
    stageAdminAudit(tx, {
      adminUid: 'system', actorRole: 'system', action: 'settlement.review_opened', entityType: 'settlement', entityId: r.id,
      reason: 'The available balance no longer covers this payout request after a balance change; held for review.',
      changedFields: ['reserved', 'payoutReview'],
      before: { status: r.status, reserved: true, review: null },
      after:  { status: r.status, reserved: false, review: 'open' },
      metadata: {
        organizerUid: input.organizerUid, amountPaise: r.amountPaise, availableAtReviewPaise: input.availablePaise,
        keptAheadPaise: r.keptAheadPaise, trigger: input.trigger,
      },
      correlation: { settlementId: r.id, organizerUid: input.organizerUid, trigger: input.trigger.ref },
    }, `settlement_review_${idPart(r.id)}_${idPart(input.trigger.ref)}`)
    const n = prepareNotification({
      workspaceUid: input.organizerUid, category: 'settlement', type: 'SETTLEMENT_UNDER_REVIEW',
      title: 'Payout under review',
      body: `Your payout request for ₹${(r.amountPaise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} is on hold for review: a refund reduced the balance available for it. Our team will review it; you can't request another payout until it is resolved.`,
      severity: 'warning', actionRequired: false, link: '/dashboard/finance/settlements',
      dedupeId: `settlement-${idPart(r.id)}-review-${idPart(input.trigger.ref)}`,
    })
    if (n) tx.set(n.ref, n.data)
  }
}

/**
 * Recovery / re-check (outside a refund): re-plan an organizer's reservations against the CURRENT available
 * balance in one transaction and route any request that no longer fits to review. Idempotent: with nothing
 * unbacked it changes nothing. Returns the requests sent to review.
 */
export async function recheckPayoutReservations(organizerUid: string, trigger: PayoutReviewTrigger): Promise<{ organizerUid: string; reviewed: Array<{ id: string; amountPaise: number }>; inTransitPaise: number | null }> {
  const walletRef = adminDb.doc(`organizerRevenueWallets/${organizerUid}`)
  return adminDb.runTransaction(async tx => {
    const walletSnap = await tx.get(walletRef)
    if (!walletSnap.exists) return { organizerUid, reviewed: [], inTransitPaise: null }
    const wallet = walletSnap.data() as OrganizerRevenueWallet
    const requests = await readOpenPayoutRequests(tx, organizerUid)
    const plan = planPayoutRefit(requests, wallet.availablePaise)
    if (plan.toReview.length === 0) return { organizerUid, reviewed: [], inTransitPaise: wallet.inTransitPaise ?? 0 }
    stagePayoutReviews(tx, { organizerUid, availablePaise: wallet.availablePaise, trigger, plan })
    tx.update(walletRef, { inTransitPaise: plan.keptPaise, updatedAt: FieldValue.serverTimestamp() })
    return { organizerUid, reviewed: plan.toReview.map(r => ({ id: r.id, amountPaise: r.amountPaise })), inTransitPaise: plan.keptPaise }
  })
}
