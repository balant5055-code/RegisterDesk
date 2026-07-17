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

export type ClawbackSourceType = 'registration' | 'donation'

export interface ClawbackDocument {
  clawbackId:             string   // 'clawback_${transactionId}' — deterministic
  organizerUid:           string
  sourceType:             ClawbackSourceType
  sourceId:               string   // registrationId | donationId
  transactionId:          string   // the platformTransactions id that was reversed
  reversalAmountPaise:    number   // total amount that needed reversing (required debit)
  recoveredAmountPaise:   number   // debited so far (immediate partial + later recoveries)
  outstandingAmountPaise: number   // reversalAmount − recovered; the live debt
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
  status:                 ClawbackStatus
  reason:                 ClawbackReason
  createdAt:              string | null
  updatedAt:              string | null
  resolvedAt:             string | null
  resolvedBy:             string | null
}
