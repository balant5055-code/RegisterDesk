// Donation domain types.
// Safe to import from both client and server — no SDK dependencies.

// ─── Lifecycle statuses ────────────────────────────────────────────────────────

export type DonationStatus =
  | 'initiated'   // widget submitted, donation doc created, no payment yet
  | 'pending'     // gateway order created, awaiting payment
  | 'successful'  // payment verified; counters updated; receipt issued
  | 'failed'      // payment failed or order expired
  | 'refunded'    // full or partial refund has been processed

export type DonationPaymentStatus =
  | 'pending'   // awaiting payment from donor
  | 'paid'      // gateway confirmed payment received
  | 'failed'    // gateway reported failure or verification mismatch
  | 'refunded'  // refund processed via gateway

// ─── Firestore documents ──────────────────────────────────────────────────────

/**
 * donations/{donationId}
 *
 * One document per donation attempt. Transitions through DonationStatus.
 * Counter update (donationCounters) happens inside an atomic transaction
 * when status moves to 'successful'.
 */
export interface DonationDocument {
  id:            string
  campaignSlug:  string
  campaignId:    string       // same as slug for now; decoupled for future slug changes
  campaignTitle: string       // denormalized — used in receipts / emails without extra reads
  organizerUid:  string       // denormalized — enables organizer dashboard queries

  // Donor identity
  donorName:  string
  donorEmail: string
  donorPhone: string | null
  donorUid?:  string          // Firebase Auth uid when donor is signed in

  // Amount — paise is authoritative; rupees stored for convenience
  amountPaise:  number        // e.g. 50000 = ₹500
  amountRupees: number        // e.g. 500

  // Donor preferences
  isAnonymous:        boolean
  showAmountPublicly: boolean
  message?:           string  // optional message shown to beneficiary
  dedication?:        string  // optional "In memory of / In honour of"

  // Lifecycle
  status:        DonationStatus
  paymentStatus: DonationPaymentStatus

  // Payment linkage — populated progressively as payment flows
  donationPaymentId?:  string  // donationPayments/{id}
  razorpayOrderId?:    string  // set when Razorpay order created (Phase 2)
  razorpayPaymentId?:  string  // set after payment verification (Phase 2)

  // Receipt — populated after successful payment
  receiptId?:     string  // donationReceipts/{id}
  receiptNumber?: string  // "RD-DON-YYYYMM-XXXXXX"

  // Timestamps
  createdAt: unknown          // Firestore Timestamp
  paidAt?:   unknown          // Firestore Timestamp — set on transition to 'successful'
  updatedAt: unknown          // Firestore Timestamp

  // Refunds (gross paise). refundedAmountPaise = finalized (accounting applied);
  // pendingRefundPaise = reserved at initiation, cleared at accounting. Refundable
  // balance = amountPaise − refundedAmountPaise − pendingRefundPaise. A donation
  // becomes status 'refunded' only when fully refunded; partial refunds stay
  // 'successful' with refundedAmountPaise > 0.
  refundedAmountPaise?: number
  pendingRefundPaise?:  number
}

/**
 * donationPayments/{paymentId}
 *
 * Tracks gateway-level payment state separately from the donation document
 * so that refund/dispute history can be appended without modifying the core
 * donation record.
 */
export interface DonationPaymentDocument {
  id:           string
  donationId:   string
  campaignSlug: string
  organizerUid: string

  amountPaise: number
  currency:    'INR'

  // Which gateway processed this payment
  gateway: 'razorpay' | 'none'

  // Gateway fields — absent until Razorpay integration (Phase 2)
  razorpayOrderId?:   string
  razorpayPaymentId?: string
  razorpaySignature?: string

  status: DonationPaymentStatus

  failureReason?: string

  // Refund tracking (Phase 2+)
  refundId?:          string
  refundStatus?:      'pending' | 'processed' | 'failed'
  refundAmountPaise?: number

  createdAt: unknown  // Firestore Timestamp
  updatedAt: unknown  // Firestore Timestamp
}

/**
 * donationReceipts/{receiptId}
 *
 * Immutable record created once per successful donation.
 * For 80G-eligible campaigns, this is the source of truth for tax receipts.
 */
export interface DonationReceiptDocument {
  id:            string
  receiptNumber: string       // "RD-DON-YYYYMM-XXXXXX" — human-readable unique ID
  donationId:    string
  campaignSlug:  string
  campaignTitle: string
  organizerUid:  string

  // Donor info — donorName is 'Anonymous' when isAnonymous === true
  donorName:  string
  donorEmail: string
  donorPan?:  string          // PAN for 80G deduction — captured post-payment

  amountPaise:  number
  amountRupees: number

  is80G: boolean              // whether campaign qualifies for Section 80G deduction

  paidAt:   unknown           // Firestore Timestamp — copied from donation.paidAt
  issuedAt: unknown           // Firestore Timestamp — when this receipt doc was created

  // PDF generation (async, populated after issuedAt)
  pdfUrl?:         string
  pdfGeneratedAt?: unknown    // Firestore Timestamp

  // Refund state — set 'refunded' on FULL refund (partial refunds leave the
  // receipt valid). Drives the REFUNDED watermark on the public receipt page.
  status?:      'issued' | 'refunded'
  refundedAt?:  unknown       // Firestore Timestamp
}

// ─── Donation refunds ───────────────────────────────────────────────────────────

export type DonationRefundStatus = 'pending' | 'processed' | 'failed'

/**
 * donationRefunds/{refundId}  — refundId is the Razorpay refund id, which is the
 * shared idempotency key across the organizer-initiated path and the
 * refund.processed webhook. Immutable: historical refunds are never overwritten.
 */
export interface DonationRefundDocument {
  id:                 string   // === razorpayRefundId
  donationId:         string
  campaignId:         string
  campaignSlug:       string
  organizerUid:       string

  razorpayRefundId:   string
  razorpayPaymentId:  string

  amountPaise:        number   // gross paise refunded by this refund
  reason:             string

  status:             DonationRefundStatus  // pending → processed (accounting applied)
  isFullRefund?:      boolean

  initiatedBy:        string   // organizer uid, or 'webhook' for gateway-originated

  ledgerReversedPaise?: number // proportional net settlement reversed
  insolvent?:         boolean  // wallet could not fully cover the reversal

  createdAt:          unknown  // Firestore Timestamp
  processedAt?:       unknown  // Firestore Timestamp — set when accounting applied
  metadata?:          Record<string, unknown>
}

/**
 * donationCounters/{campaignSlug}
 *
 * High-frequency write counter updated atomically inside the completion
 * transaction. Extends the existing CampaignCounter shape already used
 * by getCampaignCounter() in lib/firebase/firestore/campaigns.ts.
 */
export interface DonationCounter {
  campaignSlug:     string
  totalRaisedPaise: number        // sum of all successful amountPaise
  donorCount:       number        // unique donors (increment on first donation per email)
  donationCount:    number        // total successful donations (always increments)
  lastDonationAt:   unknown | null  // Firestore Timestamp
  updatedAt:        unknown         // Firestore Timestamp
}

// ─── Service input / output contracts ────────────────────────────────────────

export interface InitiateDonationInput {
  campaignSlug:  string
  campaignId:    string
  campaignTitle: string
  organizerUid:  string
  is80G:         boolean

  amountRupees: number

  donorName:  string
  donorEmail: string
  donorPhone: string | null
  donorUid?:  string

  isAnonymous:        boolean
  showAmountPublicly: boolean
  message?:           string
  dedication?:        string

  // Campaign-level bounds from donationSettings (validated against system limits)
  campaignMinAmountRupees: number
  campaignMaxAmountRupees: number | null
}

export interface InitiateDonationResult {
  donationId:      string
  amountPaise:     number
  amountRupees:    number
  // Always null until Razorpay is wired in Phase 2
  gatewayOrderId:  null
  requiresPayment: true
}

export interface CompleteDonationInput {
  donationId:        string
  razorpayOrderId:   string
  razorpayPaymentId: string
  razorpaySignature: string
}

export interface CompleteDonationResult {
  donationId:    string
  receiptId:     string
  receiptNumber: string
}

// ─── Validation error class ───────────────────────────────────────────────────

export type DonationValidationErrorCode =
  | 'AMOUNT_BELOW_MINIMUM'
  | 'AMOUNT_ABOVE_MAXIMUM'
  | 'AMOUNT_BELOW_CAMPAIGN_MINIMUM'
  | 'AMOUNT_ABOVE_CAMPAIGN_MAXIMUM'
  | 'INVALID_EMAIL'
  | 'INVALID_PHONE'
  | 'DONOR_NAME_REQUIRED'

export class DonationValidationError extends Error {
  constructor(
    public readonly code: DonationValidationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'DonationValidationError'
  }
}

// ─── Gateway adapter — plug-in boundary for Razorpay ─────────────────────────
// Implement this interface in lib/razorpay/donationGateway.ts (Phase 2).
// Pass an instance to donationService functions that need gateway calls.

export interface DonationGatewayCreateOrderParams {
  amountPaise:  number
  donationId:   string
  campaignSlug: string
  currency:     'INR'
  notes?:       Record<string, string>
}

export interface DonationGatewayOrder {
  gatewayOrderId: string
  amountPaise:    number
  currency:       'INR'
}

export interface DonationGatewayAdapter {
  createOrder(params: DonationGatewayCreateOrderParams): Promise<DonationGatewayOrder>
  verifySignature(params: {
    orderId:   string
    paymentId: string
    signature: string
  }): boolean
}
