// Platform-wide transaction and fee types.
// No SDK dependencies — safe to import from client and server.

// Type-only import: the fee model never touches a provider SDK.
import type { PaymentProvider } from '@/lib/payments/providers/types'

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

// Fee-rate tiers. `free/starter/growth/pro/enterprise` are the original V1 rate rows
// (kept byte-for-byte for historical compatibility). RD-LICENSE-GA-01 adds `professional`
// and `business` for the Licensing V2 catalog (both carry the same 1% / ₹500-cap "pro"
// economics per the V2 license definitions). Additive — no V1 row is changed.
export type PlatformPlanTier =
  | 'free' | 'starter' | 'growth' | 'pro' | 'professional' | 'business' | 'enterprise'

export type PlatformTransactionStatus =
  | 'pending'    // payment captured; not yet confirmed
  | 'completed'  // payment verified and ledger written
  | 'refunded'   // refund processed
  | 'disputed'   // chargeback in progress
  | 'backfilled' // historical record from migration (no fee collected)

// T+2 release state — tracks whether net proceeds have moved from
// pendingPaise → availablePaise in the organizer revenue wallet.
// F1 — 'held': a refund of this payment that RegisterDesk could not apply in full (a partial refund, or a
// contradictory one) is open for review. The release query only takes 'pending', so a held transaction is
// never released (and never occupies a release batch) until an authorized operator resolves the refund.
export type ReleaseStatus = 'pending' | 'released' | 'held'

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

/**
 * RD-PHASE4-S2 — the fee INPUTS in force when a checkout was created, persisted on its payment
 * intent (pricing engine OFF — with the engine ON the full `financials` breakdown is persisted
 * instead). Settlement, the webhook, the recovery sweep and the ledger rebuild compute the fee from
 * THESE, never from the live configuration, so a global fee change after checkout cannot re-price an
 * order already created. The fee itself is a pure function of (feeConfig, the intent's amount).
 */
export interface CheckoutFeeInputs {
  version:     1
  planTier:    PlatformPlanTier
  feeConfigId: string
  feeConfig:   FeeConfig
  capturedAt:  string   // ISO
  /** RD-PHASE4-S3 — where the attendee percentage came from: the event's own terms or global. Optional. */
  attendeeFeeSource?: 'event' | 'global'
}

const FEE_CONFIG_KEYS: ReadonlyArray<keyof FeeConfig> = [
  'platformFeePercentBps', 'platformFeeFixedPaise', 'platformFeeMinPaise', 'platformFeeMaxPaise',
  'gatewayFeePercentBps', 'gatewayFeeFixedPaise', 'gstRatePercent',
]
/** A stored snapshot is used only if it is complete and well-formed; anything else is ignored. */
export function isCheckoutFeeInputs(v: unknown): v is CheckoutFeeInputs {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const c = o.feeConfig as Record<string, unknown> | null | undefined
  return o.version === 1 && typeof o.planTier === 'string' && typeof o.feeConfigId === 'string'
    && typeof o.capturedAt === 'string' && typeof c === 'object' && c !== null
    && (o.attendeeFeeSource === undefined || o.attendeeFeeSource === 'event' || o.attendeeFeeSource === 'global')
    && FEE_CONFIG_KEYS.every(k => typeof c[k] === 'number' && Number.isFinite(c[k] as number) && (c[k] as number) >= 0)
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

// ─── Persisted fee breakdown (RD-PAYMENT-02 Phase 1) ────────────────────────────
// A faithful, lossless projection of FeeCalculationResult, persisted on the payment
// intent and platform transaction so the exact per-order money split is recoverable.
// ADDITIVE + OPTIONAL wherever it is embedded — absent on every prior record, so no
// existing reader or writer is affected. Field names mirror FeeCalculationResult.
// The canonical engine applies NO gateway GST, so there is deliberately no
// gatewayFeeGstPaise field. Under organizer_pays (today's universal case):
// chargeAmountPaise === ticketBasePaise and attendeeFeeTotalPaise === 0.
export interface FeeBreakdownRecord {
  financialVersion:        number   // schema version of this breakdown (see FINANCIAL_VERSION)
  feeModel:                FeeModel
  ticketBasePaise:         number   // gross / ticket value (FeeCalculationResult.grossAmountPaise)
  chargeAmountPaise:       number   // amount the attendee was charged (the Razorpay order amount)
  platformFeeBasePaise:    number
  platformFeeGstPaise:     number
  platformFeeTotalPaise:   number
  gatewayFeeEstimatePaise: number
  attendeeFeeTotalPaise:   number   // customerBearsPlatformFee + customerBearsGatewayFee
  organizerFeeTotalPaise:  number   // organizerBearsPlatformFee + organizerBearsGatewayFee
  netSettlementPaise:      number   // credited to the organizer's revenue wallet
}

// ─── Firestore document types ─────────────────────────────────────────────────

export interface PlatformTransactionDocument {
  id: string   // 'ptx_${sourceId}' — deterministic for idempotency

  // Classification
  type:     PlatformTransactionType
  category: PlatformTransactionCategory

  // Ownership
  organizerUid: string

  /**
   * RD-PAYMENT-PROVIDER-CONTRACT-04 — which gateway this money came through.
   *
   * OPTIONAL on the type, unlike the payment intent, and the asymmetry is deliberate.
   * `PlatformTransactionData` is assembled by several builders across registrations and
   * donations; making it required would force a provider argument through call paths that
   * do not yet know one, in a phase whose first requirement is that Razorpay behaviour does
   * not change. Absent is read as 'razorpay' by `readProvider`, exactly like the intent.
   *
   * It matters for the phase after Easy Split: once Cashfree settles vendors directly, the
   * ledger is the only place that can say whether a given row's money sat in RegisterDesk's
   * wallet or went straight to the organizer — and the wallet/settlement flow must not be
   * applied to rows whose money never arrived here.
   */
  provider?: PaymentProvider

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
  /**
   * What Razorpay actually charged, from the `payment.captured` payload.
   *
   * ⚠ TAX-INCLUSIVE. `gatewayTaxPaise` below is the GST COMPONENT of this number, not an
   * addition to it — verified against the gateway export, where `amount − fee = credit`
   * holds exactly. Summing the two double-counts the tax.
   *
   * Absent on every row written before RD-FIN-01, which is why every reader must keep
   * falling back to `gatewayFeeEstimatePaise` rather than treating absence as zero.
   */
  gatewayFeeActualPaise?:    number
  /** GST component contained within `gatewayFeeActualPaise`. Written with it or not at all. */
  gatewayTaxPaise?:          number
  netSettlementPaise:        number

  // Fee configuration used
  feeModel:    FeeModel
  planTier:    PlatformPlanTier
  feeConfigId: string            // 'fallback' until Firestore-backed configs exist

  // Gateway
  currency:         'INR'
  /**
   * The gateway this money came through.
   *
   * ═══ WHY THIS WAS A LITERAL, AND WHY IT IS NOT ANY MORE ═════════════════════
   * It was typed `'razorpay'`, so a Cashfree registration wrote a ledger row saying
   * `provider: 'cashfree'` and `gateway: 'razorpay'` — two fields on one document
   * contradicting each other about where the money is.
   *
   * It is now the same `PaymentProvider` vocabulary as `provider`, and the writers set both
   * from ONE resolved value so they cannot diverge. Historical rows are unaffected: they say
   * `'razorpay'` and they were Razorpay.
   *
   * Prefer `provider` in new code — it is the canonical discriminator and is normalized by
   * `readProvider`. This field is kept because it is written on every existing row; it has
   * no reader, no query and no index today, which is what made correcting it safe.
   */
  gateway:          PaymentProvider
  gatewayPaymentId: string
  gatewayOrderId:   string

  // Lifecycle
  status:        PlatformTransactionStatus
  settlementId?: string

  // Refund-reversal linkage — set on donation-refund reversal ledger entries.
  parentTransactionId?: string   // the original ptx_{sourceId} being reversed
  refundId?:            string   // the donationRefunds/{refundId} that caused it
  /** Phase 3.4 — on a compensating entry: the reversal row it cancels (net is the positive of that reversal). */
  compensatesTransactionId?: string
  entryType?:           'refund_reversal_compensation'

  // RD-PRICING-02B — INFORMATIONAL pricing snapshot. Additive + optional; absent on
  // every prior order. NOT the financial source of truth — lib/fees remains
  // authoritative. Serialized immutable OrderPricingSnapshot (historical evidence) +
  // small diagnostic meta (versions, commercial model, shadow-comparison result). No PII.
  pricingSnapshot?: string
  pricingSnapshotMeta?: {
    pricingVersion:        number
    configurationVersion:  number
    snapshotVersion:       number
    platformFeePaidBy:     string
    gatewayFeePaidBy:      string
    platformGstEnabled:    boolean
    gatewayGstEnabled:     boolean
    convenienceFeeEnabled: boolean
    shadowMatch:           boolean
    shadowDifferenceCount: number
  }
  // RD-PRICING-02C — which source produced the financial fields above: the stored
  // pricing snapshot (preferred) or the lib/fees fallback. Diagnostics; additive.
  pricingSource?: 'snapshot' | 'fallback'

  // RD-PAYMENT-02 Phase 1 — canonical fee breakdown (incl. chargeAmountPaise + who bore
  // each fee). ADDITIVE + OPTIONAL: absent on every prior transaction; the flat
  // grossAmountPaise/platformFee*/netSettlement fields above remain the authoritative
  // reads and are unchanged. Written from Phase 2 onward; nothing populates it yet.
  financials?: FeeBreakdownRecord

  // T+2 release — optional so existing documents without the field are still valid.
  // createPlatformTransaction() always writes releaseStatus: 'pending'.
  releaseStatus?: ReleaseStatus
  releasedAt?:    unknown   // set by release-funds route; FieldValue.serverTimestamp()
  /** F1 — why release is held: the open refund(s) of this payment awaiting review. Never lifted automatically. */
  releaseHold?: {
    /** RD-REFUND-RECOVER-01 · 'refund_reversal_pending' — a full refund is recorded and its ledger
     *  reversal is queued; held only so the release job cannot release refunded money meanwhile. */
    reason:        'refund_review' | 'refund_reversal_pending'
    refundIds:     string[]
    heldAt:        unknown
    /** True when the funds had ALREADY been released before the refund was seen (nothing could be held). */
    alreadyReleased?: boolean
  }

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
