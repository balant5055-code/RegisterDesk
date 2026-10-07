// RD-FIN-01 · Registration refunds as first-class records.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Refund state lived only on the registration document — `refundId`, `refundAmount`,
// `refundedAt`. Three fields on a row that describes an ATTENDEE, describing money that
// moved through a GATEWAY. That works right up to the moment the two do not correspond,
// and the 2026-08 reconciliation found exactly that: two Razorpay refunds whose parent
// captures never became registrations. There was nowhere to put them, so they were
// dropped — the webhook claimed the event, failed to resolve a registration, and returned.
//
// A refund is a gateway fact. It happened whether or not RegisterDesk can name the
// attendee it belongs to, so it gets its own record and the linkage is a separate,
// nullable relationship rather than a precondition for storing anything.
//
// ═══ SHAPE FOLLOWS donationRefunds, DELIBERATELY ═════════════════════════════
// `lib/donations/types.ts` already solved this for campaigns: doc id === Razorpay refund
// id, immutable, one record per gateway refund. This mirrors it field-for-field where the
// concepts coincide so the two read as one system. It is a SEPARATE collection rather than
// a shared `refunds` one because the linkage target differs (registration vs donation) and
// a single collection would need a discriminant on every read.

/**
 * Lifecycle of one gateway refund inside RegisterDesk.
 *
 *   recorded  — the gateway fact is persisted. Nothing has been applied yet.
 *   linked    — a registration was resolved; side effects are still pending.
 *   processed — registration updated, ledger reversed, wallet debited. Terminal.
 *   unlinked  — no registration could be resolved from the order id. NOT an error and
 *               NOT terminal: the record is complete and awaits reconciliation. This is
 *               the state the two orphaned refunds would have carried.
 */
export type RegistrationRefundStatus = 'recorded' | 'linked' | 'processed' | 'unlinked'

/** Who caused the refund to be recorded. Not who authorised it at the gateway. */
export type RegistrationRefundOrigin = 'organizer' | 'webhook' | 'admin'   // RD-FIN-02 · 'admin' = failed-refund / hold retry

/**
 * registrationRefunds/{razorpayRefundId}
 *
 * The document id IS the Razorpay refund id. That is the idempotency key for every path
 * that can observe a refund — the organizer-initiated route and the `refund.processed`
 * webhook — so the same gateway refund can never produce two records no matter how many
 * times, or in what order, it is seen.
 *
 * Deliberately NOT keyed by registrationId: a registration can carry more than one refund
 * (partial refunds), and keying by it would silently collapse the second into the first.
 */
export interface RegistrationRefundDocument {
  /** === razorpayRefundId. Duplicated into a field so queries need no id projection. */
  id:                 string
  razorpayRefundId:   string

  /** Gateway linkage — always known, because it comes from the refund payload itself. */
  gatewayPaymentId:   string | null
  gatewayOrderId:     string | null

  /**
   * RegisterDesk linkage — NULL until a registration is resolved.
   *
   * Nullable on purpose. A non-null constraint here is precisely what forced the old code
   * to discard a refund it could not attribute.
   */
  registrationId:     string | null
  eventSlug:          string | null
  organizerUid:       string | null

  /** Gross paise returned by THIS refund. Straight from the gateway, never computed. */
  amountPaise:        number

  status:             RegistrationRefundStatus
  origin:             RegistrationRefundOrigin
  /** Organizer uid for an organizer-initiated refund; 'webhook' for a gateway-originated one. */
  initiatedBy:        string
  reason:             string

  /** Set when the ledger reversal ran, so a replay can tell "applied" from "recorded". */
  ledgerReversed?:    boolean
  ledgerReversedPaise?: number

  createdAt:          unknown          // Firestore Timestamp
  processedAt?:       unknown          // Firestore Timestamp — set on `processed`
  linkedAt?:          unknown          // Firestore Timestamp — set when linkage resolved

  /**
   * Small diagnostic bag. NEVER the financial source of truth and never PII —
   * the amount above is authoritative.
   */
  metadata?:          Record<string, unknown>
}

/** What a caller must supply to record a gateway refund. */
export interface RecordRefundInput {
  razorpayRefundId:  string
  gatewayPaymentId:  string | null
  gatewayOrderId:    string | null
  amountPaise:       number
  origin:            RegistrationRefundOrigin
  initiatedBy:       string
  reason:            string
  /** Optional at record time — supplied when the caller already knows the linkage. */
  registrationId?:   string | null
  eventSlug?:        string | null
  organizerUid?:     string | null
  /**
   * Explicit lifecycle override.
   *
   * Normally the status is DERIVED from attribution (`initialStatusFor`), which is right
   * for a live refund: no registration yet ⇒ `unlinked` ⇒ still claimable.
   *
   * It is wrong for a refund that is complete on arrival. A historical capture returned by
   * remediation has nothing left to apply — no registration to update, no ledger row to
   * reverse (there never was one) — so deriving `unlinked` would leave it claimable and
   * invite a future replay to act on settled money. Such a caller states `processed`.
   *
   * Mirrors `ensureRefundRecord`'s `status?` in lib/donations/refundService.ts.
   */
  status?:           RegistrationRefundStatus
  metadata?:         Record<string, unknown>
}
