// Shared registration types.
// Safe to import from both client and server — no SDK dependencies.

// ─── Capacity Plan ────────────────────────────────────────────────────────────

export type CapacityPlan = 'free' | 'pack_500' | 'pack_1000' | 'pack_5000' | 'unlimited'

// free_event  → default capacityPlan='free'      (100 limit, upgradeable via packs)
// paid_event  → default capacityPlan='unlimited'  (no cap by default)
export type PlanType = 'free_event' | 'paid_event'

export interface CapacityPlanMeta {
  label:    string
  limit:    number | null   // null = unlimited
  // priceINR will live in the billing module when capacity packs are sold
}

// ─── Registration lifecycle ───────────────────────────────────────────────────

export type RegistrationStatus = 'confirmed' | 'cancelled' | 'waitlisted' | 'pending' | 'rejected'
export type PaymentStatus      = 'not_required' | 'pending' | 'paid' | 'refund_pending' | 'refunded'

// Origin of a registration (Phase C). Absent ⇒ 'online' for legacy records.
export type RegistrationSource     = 'online' | 'walkin'
// Walk-in payment mode collected at the gate (no Razorpay involvement).
export type WalkInPaymentMethod    = 'cash' | 'upi' | 'complimentary'

// ─── Firestore document shapes ────────────────────────────────────────────────

/**
 * registrations/{registrationId}
 *
 * Written atomically with registrationCounters update inside a transaction.
 * Attendee-facing data lives here. Organizer queries by eventSlug or organizerUid.
 */
export interface RegistrationDocument {
  id:           string
  eventSlug:    string
  passId:       string
  passName:     string
  eventName:    string        // denormalized — avoids extra read on attendee dashboard
  organizerUid: string        // denormalized — enables organizer dashboard queries
  attendee: {
    name:            string
    email:           string
    phone?:          string
    formResponses?:  Record<string, unknown>  // answers from registration form
  }
  status:        RegistrationStatus
  paymentStatus: PaymentStatus
  amount:        number        // paise; 0 for free events
  // Origin of the registration. Absent on pre-Phase-C records ⇒ treat as 'online'.
  registrationSource?: RegistrationSource
  // Walk-in payment mode (gate registration). Absent for online registrations.
  paymentMethod?:      WalkInPaymentMethod
  referenceNumber?:    string   // optional UPI/cash reference captured at the gate
  ticketCode:    string        // "RD-XXXXXXXX" — used for QR check-in
  // Ticket fields — populated at registration creation
  ticket?: {
    ticketId:      string    // equals registrationId
    qrValue:       string    // "RD:{slug}:{registrationId}:{ticketCode}"
    qrGeneratedAt: unknown   // Firestore Timestamp
  }
  // Check-in fields
  checkedIn:        boolean   // false at creation; true once scanned at gate
  checkedInAt?:     unknown   // Firestore Timestamp — set when checked in
  checkedInBy?:     string    // operator uid who performed the check-in (attribution)
  checkedInWorkspaceUid?: string  // workspace the check-in belongs to
  checkedInSource?: string    // 'qr' | 'manual' | 'search' | 'bulk' | 'walkin'
  registeredAt:  unknown       // Firestore Timestamp
  updatedAt:     unknown       // Firestore Timestamp
  uid?:          string        // Firebase Auth uid if attendee was signed in
  // Email delivery fields
  emailStatus?:        'pending' | 'sent' | 'failed'
  emailSentAt?:        unknown  // Firestore Timestamp — set when successfully sent
  emailFailureReason?: string   // last failure message if emailStatus === 'failed'
  // WhatsApp confirmation fields (Phase G3.4) — attendee WhatsApp is wallet-charged.
  whatsappStatus?:        'sent' | 'failed' | 'skipped_no_phone' | 'skipped_insufficient_balance'
  whatsappSentAt?:        unknown  // Firestore Timestamp — set when successfully sent
  whatsappMessageId?:     string   // Meta wamid when sent
  whatsappFailureReason?: string   // normalized reason when failed / skipped
  // Refund fields — populated when organizer issues a refund
  refundId?:     string   // Razorpay refund ID
  refundAmount?: number   // paise — equals amount for full refunds
  refundedAt?:   unknown  // Firestore Timestamp
  // Coupon fields — populated when a promo code was applied at registration
  couponCode?:      string  // normalized uppercase code
  discountAmount?:  number  // paise discount applied
  originalAmount?:  number  // paise before discount
  // Conference session selection (Phase G.3 / P1-1)
  selectedSessions?:   string[]   // sessions the attendee currently holds a seat in
  releasedSessions?:   string[]   // sessions released on cancel/reject/refund — kept for
                                   // audit history + to restore allocations on re-activation
  sessionsReleasedAt?: unknown    // Firestore Timestamp — last release
  sessionsRestoredAt?: unknown    // Firestore Timestamp — last restore
  // Sports-specific fields
  bibNumber?:        string | null  // assigned bib number (e.g. "0042")
  bibCategory?:      string | null  // race category label at time of assignment
  waiverAcceptedAt?: string | null  // ISO timestamp when participant accepted the waiver
  // Exhibition-specific fields (extracted from formResponses at submission time)
  companyName?:      string | null
  designation?:      string | null
  website?:          string | null
  industry?:         string | null
  passType?:         string | null  // mirrors passName for exhibition events
}

/**
 * registrationCounters/{eventSlug} — the per-event statistics SSOT (EA-2).
 *
 * Single document per event. Updated inside the registration lifecycle
 * transactions with FieldValue.increment() — atomic and consistent up to
 * ~1 write / second per document, which is sufficient for most events. For
 * high-throughput events (concerts etc.) the WRITE path is a candidate for
 * sharded counters (EA-2 Sprint 2); this sprint makes the READ path O(1).
 *
 * EA-2 S1 — denormalized aggregates (revenuePaise, status breakdown) are
 * maintained atomically alongside totalCount/passCounts so dashboards and list
 * views no longer scan the registrations collection. `statsVersion` marks the
 * doc as fully backfilled: it is stamped ONLY by publish-time init (new events,
 * whose zero stats are trivially complete) and by reconciliation after a
 * full-history recompute — NEVER by an increment, so a partially-incremented
 * legacy doc is never mistaken for a complete one. Readers MUST treat
 * `statsVersion < EVENT_STATS_VERSION` as "not yet backfilled" and fall back to
 * source-of-truth (see the dashboard / list routes).
 */
export interface RegistrationCounter {
  eventSlug:      string
  totalCount:     number                   // all confirmed registrations for this event
  passCounts:     Record<string, number>   // per-pass confirmed registration counts
  checkedInCount?: number                  // incremented atomically at each check-in
  // ── EA-2 S1: denormalized statistics (optional ⇒ backward compatible) ───────
  statsVersion?:   number                  // present + >= EVENT_STATS_VERSION ⇒ fields below are complete
  revenuePaise?:   number                  // Σ amount over CONFIRMED registrations (refund-stable)
  pendingCount?:   number                  // registrations awaiting manual approval
  cancelledCount?: number                  // cancelled registrations
  rejectedCount?:  number                  // rejected (manual-approval) registrations
  // ── EA-2 S2: per-pass attendance (event-level checkedInCount already exists) ─
  passCheckedInCounts?: Record<string, number>  // per-pass CHECKED-IN counts
  updatedAt:      unknown                  // Firestore Timestamp
}

/**
 * Bump when the shape/semantics of the denormalized statistics change so that
 * older docs are re-backfilled by reconciliation before being trusted. v2 adds
 * passCheckedInCounts (EA-2 S2) — a v1 doc is treated as incomplete until
 * reconciliation recomputes and re-stamps it, so per-pass attendance never reads
 * a missing field as zero.
 */
export const EVENT_STATS_VERSION = 2

// ─── Availability ─────────────────────────────────────────────────────────────

export type AvailabilityStatus = 'available' | 'low' | 'sold_out'

/**
 * Computed per-pass availability — not stored in Firestore, derived on read.
 */
export interface PassAvailability {
  passId:          string
  passCapacity:    number | null   // pass.quantity; null = pass is unlimited
  passCount:       number          // confirmed registrations for this pass
  eventCapacity:   number | null   // from event capacityPlan; null = event is unlimited
  eventTotalCount: number          // total confirmed registrations across all passes
  remaining:       number | null   // effective remaining seats; null = unlimited
  status:          AvailabilityStatus
}

// ─── Audit log ────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'created'
  | 'email_sent'
  | 'email_resent'
  | 'cancelled'
  | 'restored'
  | 'checked_in'
  | 'check_in_undone'
  | 'refunded'
  | 'approved'
  | 'rejected'
  | 'updated'
  | 'walkin_created'

export type AuditActorType = 'system' | 'organizer' | 'attendee'

/**
 * registrations/{registrationId}/auditLog/{autoId}
 *
 * Each document records a single lifecycle event on a registration.
 * Written fire-and-forget — never inside the registration transaction itself.
 */
export interface AuditEntry {
  id:        string
  action:    AuditAction
  actor:     string          // uid — 'system' when actorType === 'system'
  actorType: AuditActorType
  timestamp: unknown         // Firestore Timestamp
}

// ─── Registration gate ────────────────────────────────────────────────────────

export type RegistrationBlockReason =
  | 'EVENT_NOT_FOUND'         // no document in events collection
  | 'EVENT_NOT_PUBLISHED'     // draft status, not published
  | 'EVENT_CANCELLED'         // event was cancelled
  | 'EVENT_POSTPONED'         // event is postponed (registration blocked)
  | 'REGISTRATION_NOT_OPEN'   // registrationOpen date is in the future
  | 'REGISTRATION_CLOSED'     // registrationClose date passed OR event has ended
  | 'EVENT_CAPACITY_FULL'     // event-level counter >= totalCapacity
  | 'PASS_CAPACITY_FULL'      // pass-level counter >= pass.quantity
  | 'PASS_NOT_FOUND'          // passId not in event.pricing.passes
  | 'PASS_INACTIVE'           // pass.status === 'inactive'
  | 'PASS_SALES_NOT_OPEN'     // pass.salesStartDate is in the future
  | 'PASS_SALES_ENDED'        // pass.salesEndDate has passed
  | 'INVITE_CODE_REQUIRED'    // event requires an invite code; none provided
  | 'INVITE_CODE_INVALID'     // invite code provided but does not match
  | 'WAITLIST_AVAILABLE'      // capacity full but waitlist is open for this event
  | 'EVENT_UNAVAILABLE'       // admin took the event down (moderation)

export interface RegistrationGateResult {
  allowed:          boolean
  reason?:          RegistrationBlockReason
  availability?:    PassAvailability   // present when allowed === true or capacity checks ran
  waitlistEnabled?: boolean            // true when WAITLIST_AVAILABLE reason is returned
}
