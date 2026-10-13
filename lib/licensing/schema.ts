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
  isEventLicenseStatus,
  isValidTierForVersion,
  type AnyEventLicenseTier,
  type EventLicenseStatus,
  type EventLicenseFeature,
  type EventLicenseLimitKey,
  type LicenseVersion,
} from './eventLicense'
import type { CommercialTerms } from './capacityCommercial'
import type { CapacityQuote, CapacityQuoteKind } from './capacityPricing'
import type { ServiceChargeItem, ServiceSelection } from './serviceAllowances'

// ─── Collection names ───────────────────────────────────────────────────────────

export const EVENT_LICENSES_COLLECTION  = 'eventLicenses'
export const LICENSE_ORDERS_COLLECTION   = 'licenseOrders'
export const LICENSE_HISTORY_COLLECTION  = 'licenseHistory'

type Timestamp = FirebaseFirestore.Timestamp

// ─── RD-CAPACITY-01 · the immutable record of one capacity charge ────────────────
//
// Written onto the ORDER when the order is created, and onto the LICENSE when the
// activation commits. It is a flat VALUE — no references, no ids to resolve later — for
// one reason: "why was this organizer charged ₹708?" must be answerable from the document
// alone, years later, after the global rate has changed twice and the event has been
// deleted. Storing the terms by reference would make every historical amount a function
// of today's configuration, which is the opposite of an audit trail.
//
// Nothing ever rewrites one of these. A capacity change appends a NEW order with a NEW
// snapshot; it never edits the previous one.

export interface CapacityChargeSnapshot {
  /** What was charged for: a first activation, an increase, a decrease, or nothing. */
  operation:           CapacityQuoteKind
  /** The capacity the event holds after the operation. */
  capacity:            number
  /** The capacity before it. `null` for a first activation. */
  previousCapacity:    number | null
  /** The free allowance in force — NOT assumed to be 100. */
  freeCapacity:        number
  activationRatePaise: number
  /** Slots billed (slots removed, for a decrease). */
  chargeableCapacity:  number
  basePaise:           number
  gstRatePercent:      number
  gstPaise:            number
  /** basePaise + gstPaise — the amount actually collected. */
  totalPaise:          number
  /** Decrease only: the gross value of the removed capacity, before the percentage. */
  removedCapacityValuePaise?: number
  /** Decrease only: the percentage applied to that value. */
  decreaseFeePercent?: number
  /** The full commercial terms the amounts were computed from. */
  terms:               CommercialTerms
}

/**
 * Freeze a quote into a snapshot. PURE. Deep-copies the terms so a later mutation of the
 * live terms object can never reach a stored snapshot.
 */
export function capacityChargeSnapshot(quote: CapacityQuote): CapacityChargeSnapshot {
  return {
    operation:           quote.kind,
    capacity:            quote.capacity,
    previousCapacity:    quote.previousCapacity,
    freeCapacity:        quote.freeCapacity,
    activationRatePaise: quote.activationRatePaise,
    chargeableCapacity:  quote.chargeableCapacity,
    basePaise:           quote.basePaise,
    gstRatePercent:      quote.gstRatePercent,
    gstPaise:            quote.gstPaise,
    totalPaise:          quote.totalPaise,
    ...(quote.removedCapacityValuePaise !== undefined ? { removedCapacityValuePaise: quote.removedCapacityValuePaise } : {}),
    ...(quote.decreaseFeePercent !== undefined ? { decreaseFeePercent: quote.decreaseFeePercent } : {}),
    terms:               { ...quote.terms },
  }
}

/** The doc id of a capacity-change order. Deterministic in the event AND the sequence
 *  number, so a retry of the SAME change re-uses the same document (idempotent) while a
 *  genuinely new change gets a new one. Never collides with `lic_<eventId>`, which is the
 *  event's single ACTIVATION order and must stay a singleton. */
export const capacityOrderDocId = (eventId: string, seq: number): string => `cap_${eventId}_${seq}`

// ─── eventLicenses/{eventId} ────────────────────────────────────────────────────
//
// The current license attached to a single event (doc id = eventId / slug).

export interface EventLicenseDoc {
  eventId:      string             // doc id (also stored for convenience)
  organizerUid: string
  // RD-LICENSE-01B: widened to AnyEventLicenseTier so the SAME doc shape can hold a V1
  // tier (version 1) OR a V2 tier (version 2). The stored `version` selects the valid
  // vocabulary; historical docs (V1 tiers) remain valid. Widening a union is additive —
  // every existing narrowing guard (isEventLicenseTier(doc.tier) ? …) still works.
  tier:         AnyEventLicenseTier
  status:       EventLicenseStatus // 'pending' until a paid order is captured; 'active' otherwise
  version:      LicenseVersion     // license schema version this event was issued under
  amountPaise:  number             // one-time license price paid; 0 for free (starter) / admin grant
  orderId:      string | null      // licenseOrders doc id, or null (free / admin grant)
  paidAt:       Timestamp | null
  upgradedFrom: AnyEventLicenseTier | null  // previous tier when this license was upgraded
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
  // ─── RD-CAPACITY-01 · the capacity-based commercial model. ALL ADDITIVE + OPTIONAL,
  // so every historical (tier-priced) license document remains valid and readable. ───
  /** `'capacity'` marks a license issued under the capacity model. Absent ⇒ a historical
   *  tier-priced license, which keeps resolving through the V1/V2 catalogs for ever. */
  commercialModel?: 'capacity'
  /** The registration capacity this license paid for. `null` = uncapped (admin grant).
   *  This is the license's RECORD of what was bought; `events/{slug}.totalCapacity`
   *  remains the single ENFORCED value, and the two are written together. */
  capacity?:        number | null
  /** The immutable pricing record of the first activation. */
  activation?:      CapacityChargeSnapshot
  /** Monotonic counter of capacity-change operations, used to key their order documents.
   *  Starts absent (0 changes); incremented inside the capacity-change transaction. */
  capacityOpSeq?:   number
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

// RD-PRINT-BILL-P4 — 'expired': a badge purchase order whose checkout window lapsed with no capture
// (lib/licensing/printBadgePurchase/orderDoc.ts). No other purpose ever uses it.
export type LicenseOrderStatus  = 'created' | 'paid' | 'failed' | 'refunded' | 'expired'
/**
 * Why an order exists.
 *
 *   purchase          — the event's ACTIVATION order (id `lic_<eventId>`, one per event)
 *   upgrade           — historical tier upgrade (pay-the-difference). Retained for records.
 *   capacity_increase — RD-CAPACITY-01: buying additional registration capacity
 *   capacity_decrease — RD-CAPACITY-01: the charge for GIVING BACK capacity
 *
 * A decrease is deliberately NOT modelled as an `upgrade`: it is a different operation
 * with different arithmetic (a percentage of the removed capacity's value, not the value
 * itself) and it must be distinguishable in the ledger for ever. Reusing `upgrade` would
 * make "what did this organizer pay to shrink their event?" unanswerable by query.
 */
export type LicenseOrderPurpose =
  | 'purchase' | 'upgrade'
  | 'capacity_increase' | 'capacity_decrease'
  // RD-EVENT-COMMERCE-02 — a PRE-PUBLISH top-up after the activation order was paid: more
  // capacity and/or more prepaid service units for the same draft. Id `add_<draftId>_<n>`.
  | 'addon'
  // RD-PRINT-BILL-P4 — prepaid ID-badge units for a PUBLISHED event. Id `bdg_<hash>`; its own
  // document shape (printBadgePurchase/orderDoc.ts) — no tier, service lines or capacity.
  | 'print_badges'

/** The purposes that represent a capacity CHANGE (not the first activation). */
export const CAPACITY_CHANGE_PURPOSES: LicenseOrderPurpose[] = ['capacity_increase', 'capacity_decrease']

export const isCapacityChangePurpose = (p: unknown): p is 'capacity_increase' | 'capacity_decrease' =>
  p === 'capacity_increase' || p === 'capacity_decrease'

export interface LicenseOrderDoc {
  orderId:           string            // doc id (also stored for convenience)
  eventId:           string
  organizerUid:      string
  // RD-LICENSE-GA-02: widened to AnyEventLicenseTier so a V2 order is representable.
  // Orders carry no `version` — they are transient current-version artifacts.
  tier:              AnyEventLicenseTier  // tier being purchased / upgraded to
  fromTier:          AnyEventLicenseTier | null  // set for upgrades (pay-the-difference)
  purpose:           LicenseOrderPurpose
  amountPaise:       number
  currency:          'INR'
  status:            LicenseOrderStatus
  razorpayOrderId:   string | null
  razorpayPaymentId: string | null
  // The exact paise amount the Razorpay ORDER was created for — since RD-LICENSE-PAYMENT-01
  // the WHOLE price (orders written earlier may hold a wallet-first remainder; those are
  // refused as underpaid). Persisted at purchase so /checkout/confirm can bind the captured
  // payment to it (amount + order id) instead of trusting the client.
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
  // ─── RD-CAPACITY-01 · capacity-model accounting. ADDITIVE + OPTIONAL. ──────────
  /** `'capacity'` marks an order priced by registration capacity rather than by tier. */
  commercialModel?:  'capacity'
  /** The full, immutable pricing record: capacities, rate, base, GST, total, and the
   *  exact terms used. `amountPaise` above stays = the FINAL charged amount, so every
   *  existing revenue aggregate over `amountPaise` keeps working unchanged. */
  capacityChange?:   CapacityChargeSnapshot
  /** The capacity-change sequence number this order represents (see capacityOpSeq). */
  capacityOpSeq?:    number
  // ─── RD-EVENT-COMMERCE-02 · prepaid service lines. ADDITIVE + OPTIONAL. ─────────
  /** Immutable pricing record of each prepaid service bought in this order. Applied to the
   *  event's service-allowance ledger exactly once, by the payment activation transaction. */
  serviceItems?:       ServiceChargeItem[]
  /** Σ serviceItems[].totalPaise — the services share of `amountPaise` (never discounted). */
  servicesTotalPaise?: number
  /** What the organizer asked to buy, so a changed selection is never settled by an old order. */
  selection?:          { capacity: number; services: ServiceSelection }
  /** RD-EVENT-COMMERCE-03 — on a capacity-change order carrying service lines: the event's
   *  draft id, i.e. the allowance-ledger key those lines are applied to. */
  allowanceDraftId?:   string
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
  // RD-CAPACITY-01 — the capacity-based commercial model. `capacity_activated` records a
  // first activation; the other two record a paid change. Each APPENDS; nothing is edited.
  | 'capacity_activated' | 'capacity_increased' | 'capacity_decreased'
  // An admin change to an event's commercial terms (rate / free capacity / GST / …).
  | 'commercial_terms_override'
  // RD-PRINT-BILL-P2 — an admin change to an event's print badge billing (price / free / complimentary / coupons).
  | 'print_badge_override'
  // RD-PRINT-BILL-P4 — prepaid ID-badge units bought (or granted by a free coupon) for an event.
  | 'print_badges_purchased'
  // RD-PRINT-BILL-P5 — one settled badge-generation round: units kept for attendees billed, the rest released.
  | 'print_badges_consumed'
export type LicenseHistorySource = 'self_serve' | 'admin' | 'system'

export interface LicenseHistoryDoc {
  id:           string            // doc id (also stored for convenience)
  eventId:      string
  organizerUid: string
  action:       LicenseHistoryAction
  // RD-LICENSE-01B — widened to AnyEventLicenseTier so a V2 license's history is
  // representable. Historical (V1-tier) records remain valid; additive.
  fromTier:     AnyEventLicenseTier | null
  toTier:       AnyEventLicenseTier
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

/**
 * Pure shape validation for an event license doc before it is written.
 * RD-LICENSE-01B: the tier is validated against the doc's `version` (version 1 → V1
 * vocabulary, version 2 → V2 vocabulary). Version-DRIVEN — the tier name is never used
 * to infer the version. Historical V1 writes are unaffected (v1 tiers still pass).
 */
export function validateEventLicense(input: Partial<EventLicenseDoc>): LicenseValidationResult {
  const errors: string[] = []
  const version = typeof input.version === 'number' ? input.version : 1
  if (!isNonEmptyString(input.organizerUid))  errors.push('organizerUid is required')
  if (typeof input.version !== 'number' || input.version < 1) errors.push('version must be a positive integer')
  if (!isValidTierForVersion(input.tier, version)) errors.push(`tier is not valid for license version ${version}`)
  if (!isEventLicenseStatus(input.status))     errors.push('status is not a valid EventLicenseStatus')
  if (!isNonNegativeInt(input.amountPaise))    errors.push('amountPaise must be a non-negative integer')
  return { valid: errors.length === 0, errors }
}

/**
 * Pure shape validation for a license order doc before it is written.
 * The tier is validated against the order's `version` when present (else V1), mirroring
 * the license-doc rule so a V2 order carries a V2 tier. Additive — V1 orders unaffected.
 */
export function validateLicenseOrder(input: Partial<LicenseOrderDoc>): LicenseValidationResult {
  const errors: string[] = []
  const version = typeof (input as { version?: unknown }).version === 'number'
    ? (input as { version: number }).version : 1
  if (!isNonEmptyString(input.eventId))       errors.push('eventId is required')
  if (!isNonEmptyString(input.organizerUid))  errors.push('organizerUid is required')
  if (!isValidTierForVersion(input.tier, version)) errors.push(`tier is not valid for license version ${version}`)
  if (!isNonNegativeInt(input.amountPaise))   errors.push('amountPaise must be a non-negative integer')
  if (input.currency !== 'INR')               errors.push("currency must be 'INR'")
  return { valid: errors.length === 0, errors }
}
