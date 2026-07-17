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
}

export interface SettlementsApiResponse {
  requests: SettlementRequestSummary[]
}

export interface CreateSettlementResponse {
  id:          string
  status:      'pending'
  requestedAt: string
}
