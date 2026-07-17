// Event License Purchase — CONTRACTS ONLY (Phase D4.1).
//
// Shared request/response/status types that every future purchase and upgrade
// flow will use. This file is interfaces only: no implementation, no Firestore,
// no Razorpay, no service logic. Every export is a `type`/`interface` and the sole
// import is `import type`, so this module emits zero JavaScript. Nothing uses it
// yet.

import type { EventLicenseTier } from './eventLicense'

// ─── Enumerations ────────────────────────────────────────────────────────────────

/** Lifecycle status of a license purchase/order. */
export type PurchaseStatus =
  | 'pending'
  | 'created'
  | 'paid'
  | 'failed'
  | 'cancelled'
  | 'refunded'

/** How a license was (or will be) paid for. */
export type PurchaseMethod =
  | 'razorpay'    // self-serve one-time payment
  | 'admin'       // manual admin grant (no payment)
  | 'migration'   // granted by the subscription→license backfill
  | 'promotion'   // granted via a promotion / comp
  | 'future'      // reserved for later methods

/** Why a purchase or upgrade could not be completed. */
export type PurchaseFailureReason =
  | 'invalid_tier'
  | 'event_not_found'
  | 'already_licensed'
  | 'downgrade_not_allowed'
  | 'payment_failed'
  | 'payment_cancelled'
  | 'signature_invalid'
  | 'idempotency_conflict'
  | 'unknown'

// ─── Validation ──────────────────────────────────────────────────────────────────

export interface PurchaseValidationResult {
  valid:          boolean
  errors:         string[]
  failureReason?: PurchaseFailureReason
}

// ─── Checkout descriptor ─────────────────────────────────────────────────────────

/**
 * Provider-agnostic descriptor of what the client needs to complete payment.
 * Populated for `method: 'razorpay'`; null-ish for grant-based methods.
 */
export interface PurchaseCheckout {
  provider:        PurchaseMethod
  razorpayOrderId: string | null
  amountPaise:     number
  currency:        'INR'
  keyId:           string | null
}

// ─── Receipt ─────────────────────────────────────────────────────────────────────

export interface PurchaseReceipt {
  orderId:           string
  eventId:           string
  organizerUid:      string
  tier:              EventLicenseTier
  amountPaise:       number
  currency:          'INR'
  method:            PurchaseMethod
  status:            PurchaseStatus
  razorpayOrderId:   string | null
  razorpayPaymentId: string | null
  issuedAt:          string   // ISO 8601
}

// ─── Purchase ────────────────────────────────────────────────────────────────────

export interface PurchaseLicenseRequest {
  eventId:         string
  organizerUid:    string
  tier:            EventLicenseTier
  method:          PurchaseMethod
  actorUid?:       string | null   // acting admin uid when method = 'admin'
  promotionCode?:  string
  idempotencyKey?: string
}

export type PurchaseLicenseResponse =
  | { ok: true;  status: PurchaseStatus; receipt: PurchaseReceipt; checkout?: PurchaseCheckout }
  | { ok: false; status: PurchaseStatus; failureReason: PurchaseFailureReason; message: string }

// ─── Upgrade ─────────────────────────────────────────────────────────────────────

export interface LicenseUpgradeRequest {
  eventId:         string
  organizerUid:    string
  toTier:          EventLicenseTier
  method:          PurchaseMethod
  actorUid?:       string | null
  idempotencyKey?: string
}

export type LicenseUpgradeResponse =
  | {
      ok:                   true
      status:               PurchaseStatus
      fromTier:             EventLicenseTier
      toTier:               EventLicenseTier
      priceDifferencePaise: number   // pay-the-difference amount
      receipt:              PurchaseReceipt
      checkout?:            PurchaseCheckout
    }
  | { ok: false; status: PurchaseStatus; failureReason: PurchaseFailureReason; message: string }
