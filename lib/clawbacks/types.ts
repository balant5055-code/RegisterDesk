// Wallet clawback types — durable tracking of insolvent reversals.
// Safe to import from client and server (pure types + label maps).

export type ClawbackStatus =
  | 'open'                  // shortfall recorded, nothing recovered yet
  | 'partially_recovered'  // some recovered, outstanding remains
  | 'recovered'            // outstanding == 0
  | 'waived'               // finance wrote it off

// What caused the reversal that the wallet couldn't fully cover.
export type ClawbackReason =
  | 'refund'
  | 'dispute'
  | 'chargeback'
  | 'settlement_reversal'
  | 'manual'
  // M1 — a payout recorded after a CONFIRMED bank transfer that available could no longer cover (the transfer
  // had already left the bank when a refund reduced the balance): the uncovered part is owed by the organizer.
  | 'payout_shortfall'

// M1 — 'settlement': the source is a payout request (sourceId = settlementRequests id).
export type ClawbackSourceType = 'registration' | 'donation' | 'settlement'

export interface ClawbackDocument {
  clawbackId:             string   // 'clawback_${transactionId}' — deterministic
  organizerUid:           string
  sourceType:             ClawbackSourceType
  sourceId:               string   // registrationId | donationId
  transactionId:          string   // the platformTransactions id that was reversed
  reversalAmountPaise:    number   // total amount that needed reversing (required debit)
  recoveredAmountPaise:   number   // recovered FROM THE WALLET so far (immediate partial debit + release recoveries)
  outstandingAmountPaise: number   // reversalAmount − recovered − offPlatformRecovered; the live debt
  /** Phase 3.3 — collected OUTSIDE the wallet (Super Admin "mark recovered", e.g. a bank transfer). The
   *  wallet was never debited for it, so it still sits in the wallet's balance. Absent ⇒ 0. */
  offPlatformRecoveredAmountPaise?: number
  /** Phase 3.3 — each manual off-platform recovery (key = requestId): amount, who, when, why. */
  offPlatformRecoveries?: Record<string, { amountPaise: number; by: string; at: unknown; reason: string }>
  status:                 ClawbackStatus
  reason:                 ClawbackReason
  createdAt:              unknown
  updatedAt:              unknown
  resolvedAt:             unknown | null
  resolvedBy:             string | null   // admin uid (waive / mark recovered); 'system' for auto
}

export const CLAWBACK_STATUS_LABELS: Record<ClawbackStatus, string> = {
  open:                'Open',
  partially_recovered: 'Partially Recovered',
  recovered:           'Recovered',
  waived:              'Waived',
}

// Serialized for API responses (Timestamps → ISO strings).
export interface ClawbackView {
  clawbackId:             string
  organizerUid:           string
  sourceType:             ClawbackSourceType
  sourceId:               string
  transactionId:          string
  reversalAmountPaise:    number
  recoveredAmountPaise:   number
  outstandingAmountPaise: number
  offPlatformRecoveredAmountPaise: number
  status:                 ClawbackStatus
  reason:                 ClawbackReason
  createdAt:              string | null
  updatedAt:              string | null
  resolvedAt:             string | null
  resolvedBy:             string | null
}
