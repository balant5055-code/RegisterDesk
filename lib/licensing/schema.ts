// Event License Firestore schema — FOUNDATION ONLY (Phase D3.1).
//
// Collection names, document interfaces, pure converters, document-id helpers, and
// validation for the Event License data model. This file performs NO Firestore
// reads or writes and contains NO repository implementation. Nothing uses it yet;
// it exists so later phases (D3.2+) have a single, typed schema to build on.
//
// Converters are pure mapping objects (no Firestore I/O). They rely only on the
// ambient `FirebaseFirestore` types (same pattern as lib/firebase/firestore/*),
// so this module has no Firebase runtime import.

import {
  isEventLicenseTier,
  isEventLicenseStatus,
  type EventLicenseTier,
  type EventLicenseStatus,
  type EventLicenseFeature,
  type EventLicenseLimitKey,
  type LicenseVersion,
} from './eventLicense'

// ─── Collection names ───────────────────────────────────────────────────────────

export const EVENT_LICENSES_COLLECTION  = 'eventLicenses'
export const LICENSE_ORDERS_COLLECTION   = 'licenseOrders'
export const LICENSE_HISTORY_COLLECTION  = 'licenseHistory'

type Timestamp = FirebaseFirestore.Timestamp

// ─── eventLicenses/{eventId} ────────────────────────────────────────────────────
//
// The current license attached to a single event (doc id = eventId / slug).

export interface EventLicenseDoc {
  eventId:      string             // doc id (also stored for convenience)
  organizerUid: string
  tier:         EventLicenseTier
  status:       EventLicenseStatus // 'pending' until a paid order is captured; 'active' otherwise
  version:      LicenseVersion     // license schema version this event was issued under
  amountPaise:  number             // one-time license price paid; 0 for free (starter) / admin grant
  orderId:      string | null      // licenseOrders doc id, or null (free / admin grant)
  paidAt:       Timestamp | null
  upgradedFrom: EventLicenseTier | null  // previous tier when this license was upgraded
  upgradedAt:   Timestamp | null
  createdAt:    Timestamp
  updatedAt:    Timestamp
  // ─── Admin console fields (RD-LIC-ADMIN-01). All ADDITIVE + OPTIONAL: an absent
  // `admin` overlay behaves exactly as before (no override, lifecycle active). ───
  source?:      LicenseSource       // how the license was created (default 'self_serve')
  admin?:       EventLicenseAdminOverlay
  // ─── EA-4 S1: optional expiry (default OFF / absent = perpetual). A consumed
  // license's expiry never invalidates the already-published event. ─────────────
  expiresAt?:   Timestamp | null
  consumed?:    boolean
  consumedAt?:  Timestamp | null
}

// How a license came to exist. Self-serve purchase/publish, or an admin grant.
export type LicenseSource = 'self_serve' | 'admin'

// Admin lifecycle overlay — a support/governance layer ON TOP of the frozen
// status ('pending'|'active'). It never mutates the base status; runtime consumers
// treat 'suspended'/'cancelled' as not-active (workspace entitlements skip them).
export type LicenseAdminLifecycle = 'active' | 'suspended' | 'cancelled'
export const LICENSE_ADMIN_LIFECYCLES: LicenseAdminLifecycle[] = ['active', 'suspended', 'cancelled']

/** Per-event admin overrides + lifecycle. Every field is optional-by-absence. A
 *  limit override of `null` means "unlimited"; `pricePaiseOverride` of `null`
 *  means "no price override" (use the paid amount). */
export interface EventLicenseAdminOverlay {
  lifecycle:          LicenseAdminLifecycle
  complimentary:      boolean
  pricePaiseOverride: number | null
  limitOverrides:     Partial<Record<EventLicenseLimitKey, number | null>>
  featureOverrides:   Partial<Record<EventLicenseFeature, boolean>>
  paymentReceived:    boolean          // admin "mark payment received" flag
  updatedBy:          string           // admin uid of the last overlay change
  updatedAt:          Timestamp
}

// ─── licenseOrders/{orderId} ────────────────────────────────────────────────────
//
// A one-time purchase/upgrade order for an event license (doc id = orderId).

export type LicenseOrderStatus  = 'created' | 'paid' | 'failed' | 'refunded'
export type LicenseOrderPurpose = 'purchase' | 'upgrade'

export interface LicenseOrderDoc {
  orderId:           string            // doc id (also stored for convenience)
  eventId:           string
  organizerUid:      string
  tier:              EventLicenseTier  // tier being purchased / upgraded to
  fromTier:          EventLicenseTier | null  // set for upgrades (pay-the-difference)
  purpose:           LicenseOrderPurpose
  amountPaise:       number
  currency:          'INR'
  status:            LicenseOrderStatus
  razorpayOrderId:   string | null
  razorpayPaymentId: string | null
  // The exact paise amount the Razorpay ORDER was created for (the wallet-first
  // remainder). Persisted at purchase so /checkout/confirm can bind the captured
  // payment to it (amount + order id) instead of trusting the client split.
  razorpayAmountPaise?: number | null
  // Set at publish once the order is reconciled onto its published event (F2.2.1),
  // so a paid order is traceable to its event and not left attached only to a draft.
  eventSlug?:        string | null
  // ─── EA-4 S1: explicit consumption + expiry (all ADDITIVE + OPTIONAL) ─────────
  // A paid order may authorize exactly ONE event identity. `consumed` + `boundEventId`
  // (the immutable draftId) are stamped at first publish; they bind the order so it
  // can never back a second, different event identity.
  consumed?:         boolean
  boundEventId?:     string | null    // = draftId (immutable Event ID) the order was consumed by
  consumedAt?:       Timestamp | null
  // Optional expiry — default OFF (absent = perpetual). Enforced only before the
  // license is consumed; a consumed order's expiry never invalidates its published event.
  expiresAt?:        Timestamp | null
  // ─── EA-4 S2: License-coupon accounting (all ADDITIVE + OPTIONAL) ─────────────
  // licenseOrders is the SINGLE financial source of truth: original price, the
  // discount given, the final charged amount, the code, campaign, and an IMMUTABLE
  // coupon snapshot (so history survives later coupon edits). `amountPaise` above
  // stays = the FINAL charged amount, so existing revenue aggregates stay correct.
  couponCode?:         string | null
  campaign?:           string | null
  originalPricePaise?: number
  discountPaise?:      number
  finalPricePaise?:    number
  couponSnapshot?:     LicenseCouponSnapshotDoc | null
  createdAt:         Timestamp
  updatedAt:         Timestamp
  paidAt:            Timestamp | null
}

/** Immutable coupon snapshot embedded in an order (mirrors the domain snapshot;
 *  duplicated here to keep this schema free of a cross-domain import). */
export interface LicenseCouponSnapshotDoc {
  code:        string
  type:        'percentage' | 'fixed' | 'free'
  value:       number
  description: string
  campaign:    string
  version:     number
}

// ─── licenseHistory/{autoId} ─────────────────────────────────────────────────────
//
// Immutable audit trail of every license change (purchase, activation, upgrade,
// admin grant, refund). Doc id is auto-generated.

export type LicenseHistoryAction =
  | 'purchased' | 'activated' | 'upgraded' | 'granted' | 'refunded'
  // RD-LIC-ADMIN-01 — admin console lifecycle + override + note actions.
  | 'downgraded' | 'suspended' | 'reactivated' | 'cancelled' | 'reissued'
  | 'price_override' | 'limit_override' | 'feature_override' | 'payment_received' | 'note'
  // EA-4 S1 — governance / expiry / consumption
  | 'expiry_extended' | 'expiry_reduced' | 'expiry_disabled'
  | 'governance_override' | 'force_consumed' | 'reset'
export type LicenseHistorySource = 'self_serve' | 'admin' | 'system'

export interface LicenseHistoryDoc {
  id:           string            // doc id (also stored for convenience)
  eventId:      string
  organizerUid: string
  action:       LicenseHistoryAction
  fromTier:     EventLicenseTier | null
  toTier:       EventLicenseTier
  source:       LicenseHistorySource
  orderId:      string | null
  actorUid:     string | null     // acting admin/user uid when source = 'admin'
  note:         string
  // RD-LIC-ADMIN-01 — immutable before/after + reason for admin actions (never
  // overwritten; each change appends a new history doc).
  reason?:      string
  before?:      unknown
  after?:       unknown
  createdAt:    Timestamp
}

// ─── Document id helpers ─────────────────────────────────────────────────────────
//
// Encode the id strategy in one place: event licenses are keyed by eventId, orders
// by their orderId; history docs use auto-generated ids.

export const eventLicenseDocId = (eventId: string): string => eventId
export const licenseOrderDocId = (orderId: string): string => orderId

// ─── Converters ──────────────────────────────────────────────────────────────────
//
// Pure mappings between domain docs and Firestore data. The id field is also
// stored in the body for convenience but is always authoritatively taken from the
// snapshot id on read.

export const eventLicenseConverter: FirebaseFirestore.FirestoreDataConverter<EventLicenseDoc> = {
  toFirestore(doc) {
    return { ...doc }
  },
  fromFirestore(snapshot) {
    return { ...(snapshot.data() as EventLicenseDoc), eventId: snapshot.id }
  },
}

export const licenseOrderConverter: FirebaseFirestore.FirestoreDataConverter<LicenseOrderDoc> = {
  toFirestore(doc) {
    return { ...doc }
  },
  fromFirestore(snapshot) {
    return { ...(snapshot.data() as LicenseOrderDoc), orderId: snapshot.id }
  },
}

export const licenseHistoryConverter: FirebaseFirestore.FirestoreDataConverter<LicenseHistoryDoc> = {
  toFirestore(doc) {
    return { ...doc }
  },
  fromFirestore(snapshot) {
    return { ...(snapshot.data() as LicenseHistoryDoc), id: snapshot.id }
  },
}

// ─── Validation ──────────────────────────────────────────────────────────────────

export interface LicenseValidationResult {
  valid:  boolean
  errors: string[]
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNonNegativeInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0

/** Pure shape validation for an event license doc before it is written. */
export function validateEventLicense(input: Partial<EventLicenseDoc>): LicenseValidationResult {
  const errors: string[] = []
  if (!isNonEmptyString(input.organizerUid))  errors.push('organizerUid is required')
  if (!isEventLicenseTier(input.tier))         errors.push('tier is not a valid EventLicenseTier')
  if (!isEventLicenseStatus(input.status))     errors.push('status is not a valid EventLicenseStatus')
  if (typeof input.version !== 'number' || input.version < 1) errors.push('version must be a positive integer')
  if (!isNonNegativeInt(input.amountPaise))    errors.push('amountPaise must be a non-negative integer')
  return { valid: errors.length === 0, errors }
}

/** Pure shape validation for a license order doc before it is written. */
export function validateLicenseOrder(input: Partial<LicenseOrderDoc>): LicenseValidationResult {
  const errors: string[] = []
  if (!isNonEmptyString(input.eventId))       errors.push('eventId is required')
  if (!isNonEmptyString(input.organizerUid))  errors.push('organizerUid is required')
  if (!isEventLicenseTier(input.tier))        errors.push('tier is not a valid EventLicenseTier')
  if (!isNonNegativeInt(input.amountPaise))   errors.push('amountPaise must be a non-negative integer')
  if (input.currency !== 'INR')               errors.push("currency must be 'INR'")
  return { valid: errors.length === 0, errors }
}
