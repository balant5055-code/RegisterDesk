// Client-safe types for the Admin License Management Console (RD-LIC-ADMIN-01).
// NO firebase-admin / server imports — shared by the page and the API layer.

import type { AnyEventLicenseTier, EventLicenseFeature, EventLicenseLimitKey } from '@/lib/licensing/eventLicense'
import type { LicenseAdminLifecycle } from '@/lib/licensing/schema'

// Display status shown in the console = base status folded with the admin lifecycle.
export type LicenseDisplayStatus = 'active' | 'pending' | 'suspended' | 'cancelled'

// Payment state derived from the license order / grant.
export type LicensePaymentStatus = 'paid' | 'pending' | 'failed' | 'refunded' | 'free' | 'complimentary'
  // RD-SA-COMMERCE-P1 (P1-5) — the activation order is claimed by a licence refund that has not finished.
  | 'refunding'

export interface LicenseRow {
  eventId:             string
  eventName:           string
  eventStatus:         string | null   // event lifecycleStatus (published / pending_review / …)
  organizerUid:        string
  organizerName:       string
  organizerEmail:      string
  organizationName:    string
  // RD-LICENSE-01B Phase 3C.1: stored tier (V1 or V2) + its version-aware display name.
  tier:                AnyEventLicenseTier
  tierName:            string
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
  fromTier:  AnyEventLicenseTier | null
  toTier:    AnyEventLicenseTier
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
  /** RD-EVENT-COMMERCE-04 — true for a capacity-model licence: its capacity was bought, so the
   *  tier actions (upgrade/downgrade/grant) and "mark paid" do not apply (the server refuses them). */
  capacityModel?: boolean
  /** RD-EVENT-COMMERCE-04B — the CALLER may change licence pricing (Super Admin). Set by the route. */
  canEditPricing?: boolean
  /** RD-SA-COMMERCE-P1 — the refund state Super Admins must see (read-only; nothing here acts). */
  refundState?: LicenseRefundStateView
}

/**
 * RD-SA-COMMERCE-P1 · what a licence's refund fields say. `hold` is a refund that claimed the licence
 * and has not finished (new sales are blocked while it exists); it is NEVER released for being old —
 * see docs/RD-SA-COMMERCE-P1-REFUND-HOLDS.md. `review` is the last refund refused for a decision.
 */
export interface LicenseRefundStateView {
  hold:   {
    orderId: string | null; by: string | null; at: string | null; ageHours: number | null
    /** claimed | gateway | unknown (outcome not established) | completing — see lib/licensing/licenceRefundHold.ts */
    phase: string | null
    /** PD-2 — earliest time a release may even be considered (age is necessary, never sufficient). */
    releasableAfter: string | null
    /** Whether that time had passed when this view was built (advisory — the server re-checks on release). */
    releaseAgeReached: boolean
    /** The gateway lookup result recorded when the outcome could not be established (unknown / partial). */
    gatewayOutcome: string | null
  } | null
  /** P1-3 — the licence order is still `refunding` with NO hold (claimed by the code before holds existed). */
  legacyRefundingOrder: { orderId: string; since: string | null } | null
  /** M2 — a licence refund the gateway accepted and later reported FAILED (open until a Super Admin acknowledges). */
  refundFailure: {
    status: string | null; evidence: string | null; refundIds: string[]; amountPaise: number | null
    firstAt: string | null; acknowledgedBy: string | null; acknowledgedReason: string | null
  } | null
  review: {
    at: string | null; by: string | null; reason: string | null; conflicts: string[]
    totalRefundPaise: number | null; sold: number | null; capacityBefore: number | null; capacityAfter: number | null
  } | null
  refundedAt:            string | null
  entitlementRestoredAt: string | null
  /** True while the licence refuses new registrations / purchases (suspended, cancelled, refunded, mid-refund). */
  blocksNewSales:        boolean
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
  // RD-SA-COMMERCE-P1 — release the hold of a licence refund that never moved money (reconciliation)
  | 'releaseRefundHold'
  | 'completeRefund'
  | 'acknowledgeRefundFailure'

export const LICENSE_ACTIONS_REQUIRING_REASON: LicenseAdminActionType[] = [
  'grant', 'suspend', 'reactivate', 'cancel', 'upgrade', 'downgrade',
  'overridePrice', 'overrideLimit', 'overrideFeatures', 'markPaymentReceived',
  'refund', 'reissue',
  // EA-4 S1 — all governance/expiry/consumption actions require a reason + audit.
  'extendExpiry', 'reduceExpiry', 'disableExpiry',
  'overridePublish', 'overrideIdentity', 'overrideRegistrationSafety',
  'forceConsume', 'resetLicense',
  'releaseRefundHold',
  'completeRefund',
  'acknowledgeRefundFailure',
]

export interface LicenseAdminActionRequest {
  action:        LicenseAdminActionType
  reason:        string
  // action-specific payload (all optional; validated server-side per action against
  // CURRENT_LICENSE_VERSION). RD-LICENSE-GA-02: widened to accept a V2 grant/upgrade target.
  tier?:         AnyEventLicenseTier
  complimentary?: boolean
  pricePaise?:   number
  limitKey?:     EventLicenseLimitKey
  limitValue?:   number | null        // null = unlimited
  features?:     Partial<Record<EventLicenseFeature, boolean>>
  note?:         string
  // EA-4 S1
  expiryDays?:     number             // extendExpiry / reduceExpiry — new window in days
  overrideEnabled?: boolean           // override* — enable (default true) or clear the override
  // RD-SA-COMMERCE-P1
  dryRun?:                   boolean  // refund — preview the refund assessment; changes nothing
  restoreRefundedEntitlement?: boolean // reactivate / reissue — explicitly restore a REFUNDED licence
}

/** RD-SA-COMMERCE-P1 — the refund preview / refusal payload (mirrors lib/licensing/licenceRefundAssessment). */
export interface LicenseRefundAssessmentView {
  gatewayRefundPaise: number
  walletCreditPaise:  number
  totalRefundPaise:   number
  paidSeats:          number | null
  sold:               number
  capacityBefore:     number | null
  capacityAfter:      number | null
  capacityChange:     boolean
  services:           Array<{ service: string; bought: number; retirable: number; consumed: number }>
  conflicts:          Array<{ code: string; message: string }>
}

export interface LicenseAdminActionResponse {
  ok:      boolean
  eventId: string
  action:  LicenseAdminActionType
  message?: string
  // Present for refunds so the UI can surface the outcome.
  refund?: {
    gatewayRefunded: boolean; walletCreditedPaise: number; servicesRetired?: Record<string, number>; otherPaidOrdersNotRefunded?: string[]
    /** RD-SA-COMMERCE-P1 — the event capacity before/after the refunded seats came off, and the sold floor. */
    capacityBefore?: number | null; capacityAfter?: number | null; sold?: number
  }
  /** RD-SA-COMMERCE-P1 — refund `dryRun` preview. */
  refundAssessment?: LicenseRefundAssessmentView
  /** RD-PHASE4-S4 · F3 — money moved but a follow-up step failed; recorded for reconciliation. */
  reconciliation?: string[]
}
