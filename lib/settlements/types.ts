import type { SettlementPayoutDestination } from '@/lib/payout/binding'

export type SettlementStatus = 'pending' | 'approved' | 'paid' | 'rejected'

export interface SettlementRequestDoc {
  organizerUid:  string
  // Operator who requested the settlement (attribution). Optional/absent on
  // pre-attribution historical records.
  requestedBy?:  string
  amountPaise:   number
  status:        SettlementStatus
  requestedAt:   unknown        // Firestore Timestamp / FieldValue at write time
  approvedAt:    unknown | null
  paidAt:        unknown | null
  adminNote:     string
  // True when the request placed a hold on the wallet's inTransitPaise at
  // creation (all requests created after the transactional-reservation fix).
  // The hold is released on paid/rejected only when this is true, so legacy
  // pre-fix requests (no hold) don't decrement inTransitPaise.
  reserved?:     boolean
  // Payout proof — written when admin marks status = 'paid'
  utrNumber?:    string
  bankReference?: string
  paidBy?:       string
  paymentNotes?: string
  // RD-PHASE4-S4 — maker-checker (D2) and destination binding (D5). Absent on older records.
  /** The Super Admin who approved. A DIFFERENT Super Admin must mark it paid. */
  approvedBy?:   string
  /** The Super Admin who marked it paid (server-set; `paidBy` above is free-text proof). */
  paidByAdmin?:  string
  rejectedBy?:   string
  /** The verified payout destination this request was made against (masked). */
  payoutDestination?: SettlementPayoutDestination | null
  /**
   * M1 — payout review. Set when a refund (or a payout recorded after a confirmed transfer) left the wallet
   * unable to back this request: the request keeps its status and FULL amount, its reservation is released
   * (`reserved: false`, so inTransitPaise stays ≤ availablePaise) and it cannot be approved or marked paid
   * until a Super Admin resolves the review (lib/settlements/payoutReview.ts). Absent = never reviewed.
   */
  payoutReview?: SettlementPayoutReview
  /**
   * M1.2 — the changed-destination exception: recording a transfer that ALREADY completed to the ORIGINAL
   * destination after the organizer's payout details changed (lib/settlements/confirmedTransfer.ts). Initiated by
   * one Super Admin, approved by another; never sends money. Absent = never requested.
   */
  transferException?: SettlementTransferException
  /** M1.2 — earlier exception attempts that were declined (kept as evidence), keyed by attempt */
  transferExceptionHistory?: Record<string, SettlementTransferException>
}

export interface SettlementTransferException {
  status:         'pending_approval' | 'approved' | 'declined'
  amountPaise:    number
  /** normalized UTR / bank transfer reference */
  utrNumber:      string
  reason:         string
  evidence:       {
    originalDestination: { verifiedVersion: number; label: string | null }
    transfer:            { source: string; reference: string; observation: 'transfer_completed' }
  }
  /** the binding the approval must restate (request, amount, UTR, evidence) */
  fingerprint:    string
  /** why the standard path refused when the exception was requested */
  bindingCodeAtRequest: 'UNVERIFIED_PROFILE' | 'DESTINATION_CHANGED'
  initiatedBy:    string
  initiatedAt:    unknown
  approvedBy?:    string
  approvedAt?:    unknown
  approvalReason?: string
  declinedBy?:    string
  declinedAt?:    unknown
  declineReason?: string
}

export type PayoutReviewTriggerKind = 'registration_refund' | 'donation_refund' | 'payout_after_transfer' | 'manual_recheck'
export type PayoutReviewOutcome = 'resumed' | 'rejected' | 'paid_after_transfer'

export interface SettlementPayoutReview {
  status:                 'open' | 'resolved'
  reason:                 'available_below_reservations'
  trigger:                { kind: PayoutReviewTriggerKind; ref: string }
  openedAt:               unknown
  /** the request's status and amount when the review opened (the amount is never changed) */
  statusAtReview:         'pending' | 'approved'
  requestedAmountPaise:   number
  /** availablePaise after the triggering change, and what the requests kept ahead of this one already held */
  availableAtReviewPaise: number
  keptAheadPaise:         number
  // ── set on resolution ──
  outcome?:               PayoutReviewOutcome
  resolvedAt?:            unknown
  resolvedBy?:            string
  resolutionReason?:      string
  /** paid_after_transfer: the part available could not cover (recorded as a clawback) */
  shortfallPaise?:        number
  clawbackId?:            string | null
}

export interface SettlementRequestSummary {
  id:             string
  amountPaise:    number
  status:         SettlementStatus
  requestedAt:    string          // ISO 8601
  approvedAt:     string | null
  paidAt:         string | null
  adminNote:      string
  // Payout proof — present only when status = 'paid'
  utrNumber?:     string
  bankReference?: string
  paidBy?:        string
  paymentNotes?:  string
  /** M1 — the request is held for review (a refund reduced the balance backing it) */
  underReview?:   boolean
}

export interface SettlementsApiResponse {
  requests: SettlementRequestSummary[]
}

export interface CreateSettlementResponse {
  id:          string
  status:      'pending'
  requestedAt: string
}
