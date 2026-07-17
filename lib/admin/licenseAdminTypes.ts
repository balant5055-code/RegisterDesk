// Client-safe types for the Admin License Management Console (RD-LIC-ADMIN-01).
// NO firebase-admin / server imports — shared by the page and the API layer.

import type { EventLicenseTier, EventLicenseFeature, EventLicenseLimitKey } from '@/lib/licensing/eventLicense'
import type { LicenseAdminLifecycle } from '@/lib/licensing/schema'

// Display status shown in the console = base status folded with the admin lifecycle.
export type LicenseDisplayStatus = 'active' | 'pending' | 'suspended' | 'cancelled'

// Payment state derived from the license order / grant.
export type LicensePaymentStatus = 'paid' | 'pending' | 'failed' | 'refunded' | 'free' | 'complimentary'

export interface LicenseRow {
  eventId:             string
  eventName:           string
  eventStatus:         string | null   // event lifecycleStatus (published / pending_review / …)
  organizerUid:        string
  organizerName:       string
  organizerEmail:      string
  organizationName:    string
  tier:                EventLicenseTier
  displayStatus:       LicenseDisplayStatus
  lifecycle:           LicenseAdminLifecycle
  complimentary:       boolean
  source:              'self_serve' | 'admin'
  amountPaidPaise:     number          // what was actually paid (0 for free/grant)
  effectivePricePaise: number          // admin price override, else amountPaid
  registrationLimit:   number | null   // effective; null = unlimited
  used:                number          // current registration count
  purchaseDate:        string | null   // ISO
  paymentStatus:       LicensePaymentStatus
  hasOverrides:        boolean
  updatedAt:           string | null   // ISO
}

export interface LicenseListResponse {
  items:      LicenseRow[]
  nextCursor: string | null
}

export interface LicenseTimelineEntry {
  id:        string
  action:    string
  fromTier:  EventLicenseTier | null
  toTier:    EventLicenseTier
  source:    'self_serve' | 'admin' | 'system'
  actorUid:  string | null
  note:      string
  reason:    string | null
  createdAt: string | null   // ISO
}

export interface LicenseDetail {
  row:      LicenseRow
  overlay:  {
    lifecycle:          LicenseAdminLifecycle
    complimentary:      boolean
    pricePaiseOverride: number | null
    limitOverrides:     Partial<Record<EventLicenseLimitKey, number | null>>
    featureOverrides:   Partial<Record<EventLicenseFeature, boolean>>
    paymentReceived:    boolean
  } | null
  order:    {
    orderId:           string
    status:            string
    amountPaise:       number
    razorpayPaymentId: string | null
  } | null
  timeline: LicenseTimelineEntry[]
}

// ─── Admin actions ────────────────────────────────────────────────────────────

export type LicenseAdminActionType =
  | 'grant' | 'suspend' | 'reactivate' | 'cancel'
  | 'upgrade' | 'downgrade'
  | 'overridePrice' | 'overrideLimit' | 'overrideFeatures'
  | 'markPaymentReceived' | 'refund' | 'reissue' | 'addNote'
  // EA-4 S1 — expiry, publish-governance overrides, consumption controls
  | 'extendExpiry' | 'reduceExpiry' | 'disableExpiry'
  | 'overridePublish' | 'overrideIdentity' | 'overrideRegistrationSafety'
  | 'forceConsume' | 'resetLicense'

export const LICENSE_ACTIONS_REQUIRING_REASON: LicenseAdminActionType[] = [
  'grant', 'suspend', 'reactivate', 'cancel', 'upgrade', 'downgrade',
  'overridePrice', 'overrideLimit', 'overrideFeatures', 'markPaymentReceived',
  'refund', 'reissue',
  // EA-4 S1 — all governance/expiry/consumption actions require a reason + audit.
  'extendExpiry', 'reduceExpiry', 'disableExpiry',
  'overridePublish', 'overrideIdentity', 'overrideRegistrationSafety',
  'forceConsume', 'resetLicense',
]

export interface LicenseAdminActionRequest {
  action:        LicenseAdminActionType
  reason:        string
  // action-specific payload (all optional; validated server-side per action)
  tier?:         EventLicenseTier
  complimentary?: boolean
  pricePaise?:   number
  limitKey?:     EventLicenseLimitKey
  limitValue?:   number | null        // null = unlimited
  features?:     Partial<Record<EventLicenseFeature, boolean>>
  note?:         string
  // EA-4 S1
  expiryDays?:     number             // extendExpiry / reduceExpiry — new window in days
  overrideEnabled?: boolean           // override* — enable (default true) or clear the override
}

export interface LicenseAdminActionResponse {
  ok:      boolean
  eventId: string
  action:  LicenseAdminActionType
  message?: string
  // Present for refunds so the UI can surface the outcome.
  refund?: { gatewayRefunded: boolean; walletCreditedPaise: number }
}
