// Platform-wide transaction and fee types.
// No SDK dependencies — safe to import from client and server.

export type PlatformTransactionType =
  | 'event_registration'
  | 'donation'
  | 'workshop_fee'
  | 'conference_ticket'
  | 'marathon_registration'
  | 'exhibition_booth'
  | 'sponsorship_package'
  | 'membership'

export type PlatformTransactionCategory =
  | 'ticketed'      // commercial events
  | 'donation'      // charitable giving
  | 'subscription'  // recurring memberships

export type FeeModel =
  | 'customer_pays'   // buyer pays gross + all fees; organizer receives gross
  | 'organizer_pays'  // buyer pays gross; organizer receives gross − fees
  | 'hybrid'          // platform fee split by hybridRatio; gateway always on organizer
  | 'no_fee'          // free events or zero-amount transactions

export type PlatformPlanTier = 'free' | 'starter' | 'growth' | 'pro' | 'enterprise'

export type PlatformTransactionStatus =
  | 'pending'    // payment captured; not yet confirmed
  | 'completed'  // payment verified and ledger written
  | 'refunded'   // refund processed
  | 'disputed'   // chargeback in progress
  | 'backfilled' // historical record from migration (no fee collected)

// T+2 release state — tracks whether net proceeds have moved from
// pendingPaise → availablePaise in the organizer revenue wallet.
export type ReleaseStatus = 'pending' | 'released'

// ─── Fee config ───────────────────────────────────────────────────────────────

export interface FeeConfig {
  platformFeePercentBps: number   // basis points (200 = 2.00%)
  platformFeeFixedPaise: number   // fixed component added after percent
  platformFeeMinPaise:   number   // floor (0 = no floor)
  platformFeeMaxPaise:   number   // ceiling (0 = uncapped)
  gatewayFeePercentBps:  number   // estimated gateway cost (Razorpay actual varies)
  gatewayFeeFixedPaise:  number
  gstRatePercent:        number   // 18 for India
}

// ─── Fee calculation ──────────────────────────────────────────────────────────

export interface FeeCalculationInput {
  transactionType:  PlatformTransactionType
  grossAmountPaise: number
  feeModel:         FeeModel
  hybridRatio?:     number        // 0.0–1.0; fraction of platform fee borne by customer
  config:           FeeConfig
}

export interface FeeCalculationResult {
  grossAmountPaise:          number

  // Platform fee components
  platformFeeBasePaise:      number
  platformFeeGstPaise:       number
  platformFeeTotalPaise:     number

  // Gateway fee estimate (Razorpay actual backfilled later from settlement webhook)
  gatewayFeeEstimatePaise:   number

  // Amount used to create the Razorpay order
  chargeAmountPaise:         number

  // Amount credited to organizer revenue wallet
  netSettlementPaise:        number

  // Attribution breakdown — who bears what
  customerBearsPlatformFee:  number
  organizerBearsPlatformFee: number
  customerBearsGatewayFee:   number
  organizerBearsGatewayFee:  number
}

// ─── Firestore document types ─────────────────────────────────────────────────

export interface PlatformTransactionDocument {
  id: string   // 'ptx_${sourceId}' — deterministic for idempotency

  // Classification
  type:     PlatformTransactionType
  category: PlatformTransactionCategory

  // Ownership
  organizerUid: string

  // Source entity
  entityId:   string              // eventSlug | campaignSlug
  entityType: 'event' | 'campaign'
  sourceId:   string              // registrationId | donationId
  sourceType: 'registration' | 'donation'

  // Payer (denormalized for reporting without joins)
  payerName:  string
  payerEmail: string

  // Amounts — all paise, all final at write time
  grossAmountPaise:          number
  platformFeeBasePaise:      number
  platformFeeGstPaise:       number
  platformFeeTotalPaise:     number
  gatewayFeeEstimatePaise:   number
  gatewayFeeActualPaise?:    number   // backfilled from Razorpay settlement webhook
  netSettlementPaise:        number

  // Fee configuration used
  feeModel:    FeeModel
  planTier:    PlatformPlanTier
  feeConfigId: string            // 'fallback' until Firestore-backed configs exist

  // Gateway
  currency:         'INR'
  gateway:          'razorpay'
  gatewayPaymentId: string
  gatewayOrderId:   string

  // Lifecycle
  status:        PlatformTransactionStatus
  settlementId?: string

  // Refund-reversal linkage — set on donation-refund reversal ledger entries.
  parentTransactionId?: string   // the original ptx_{sourceId} being reversed
  refundId?:            string   // the donationRefunds/{refundId} that caused it

  // T+2 release — optional so existing documents without the field are still valid.
  // createPlatformTransaction() always writes releaseStatus: 'pending'.
  releaseStatus?: ReleaseStatus
  releasedAt?:    unknown   // set by release-funds route; FieldValue.serverTimestamp()

  paidAt:    unknown   // FieldValue.serverTimestamp() — typed as unknown to allow admin/client FieldValue
  createdAt: unknown
  updatedAt: unknown
}

export interface OrganizerRevenueWallet {
  organizerUid: string
  currency:     'INR'
  planTier:     PlatformPlanTier

  // Lifetime totals (credits only — not decremented on refund)
  lifetimeGrossPaise: number
  lifetimeFeesPaise:  number   // platformFeeTotal + gatewayFeeEstimate
  lifetimeNetPaise:   number

  // Balance states (must sum to current net balance)
  pendingPaise:   number   // Phase 1: all balance accumulates here (T+2 release in Phase 3+)
  availablePaise: number   // released; ready for payout
  inTransitPaise: number   // payout initiated but not yet settled
  settledPaise:   number   // paid out to bank account

  updatedAt:        unknown
  lastSettlementAt: unknown | null
}
