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

export type RegistrationStatus = 'confirmed' | 'cancelled' | 'waitlisted' | 'pending'
export type PaymentStatus      = 'not_required' | 'pending' | 'paid' | 'refunded'

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
  checkedInBy?:     string    // organizer UID who performed the scan
  checkedInSource?: string    // 'qr' | 'manual' | 'search' | 'bulk'
  registeredAt:  unknown       // Firestore Timestamp
  updatedAt:     unknown       // Firestore Timestamp
  uid?:          string        // Firebase Auth uid if attendee was signed in
  // Email delivery fields
  emailStatus?:        'pending' | 'sent' | 'failed'
  emailSentAt?:        unknown  // Firestore Timestamp — set when successfully sent
  emailFailureReason?: string   // last failure message if emailStatus === 'failed'
  // Refund fields — populated when organizer issues a refund
  refundId?:     string   // Razorpay refund ID
  refundAmount?: number   // paise — equals amount for full refunds
  refundedAt?:   unknown  // Firestore Timestamp
}

/**
 * registrationCounters/{eventSlug}
 *
 * Single document per event.  Updated inside the registration transaction with
 * FieldValue.increment() — atomic and consistent up to ~1 write / second, which
 * is sufficient for most events.  For high-throughput events (concerts etc.) this
 * should be replaced with sharded counters.
 */
export interface RegistrationCounter {
  eventSlug:      string
  totalCount:     number                   // all confirmed registrations for this event
  passCounts:     Record<string, number>   // per-pass confirmed registration counts
  checkedInCount?: number                  // incremented atomically at each check-in
  updatedAt:      unknown                  // Firestore Timestamp
}

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

export interface RegistrationGateResult {
  allowed:      boolean
  reason?:      RegistrationBlockReason
  availability?: PassAvailability   // present when allowed === true or capacity checks ran
}
