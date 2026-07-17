// Client-safe types for the Enterprise License & Coupon Command Center (GA-2 S3).
// NO firebase-admin / server imports — shared by the page and the API layer.
//
// The center is READ-first over thin admin endpoints that REUSE existing engines:
//   • Licenses  → GET /api/admin/licenses (+ /[eventId] detail & all 21 actions)
//   • Coupons   → GET/POST /api/admin/license-coupons (+ /[code])  [engine reused]
//   • Business  → GET /api/admin/analytics (getAdminAnalytics)
//   • Overview  → GET /api/admin/license-center/overview  (status/expiry + health)
//   • Timeline  → GET /api/admin/license-center/timeline  (merged audit + history)
// NO new licensing/coupon engine, NO new payment flow, NO duplicated mutations.

import type { EventLicenseTier } from '@/lib/licensing/eventLicense'
import type { LicenseCouponType, LicenseCouponLifecycle } from '@/lib/licensing/coupons/types'

// ─── Health Panel ───────────────────────────────────────────────────────────

export type HealthLevel = 'green' | 'yellow' | 'red' | 'neutral'

export type HealthKey =
  | 'license_engine' | 'coupon_engine' | 'payments' | 'revenue'
  | 'expiry' | 'campaigns' | 'discount_budget'

export interface HealthIndicator {
  key:    HealthKey
  label:  string
  level:  HealthLevel
  detail: string
}

// ─── Overview payload ─────────────────────────────────────────────────────────

export interface LicenseCenterOverview {
  licenses: {
    total:     number
    active:    number
    pending:   number
    suspended: number
    cancelled: number
    consumed:  number
    expired:   number
  }
  coupons: {
    total:     number
    active:    number
    paused:    number
    scheduled: number
    expired:   number
    archived:  number
    campaigns: number
  }
  revenue: {
    licenseRevenuePaise: number
    paidCount:           number
    refundedCount:       number
    discountGivenPaise:  number
    couponRedemptions:   number
  }
  topCoupons:  { label: string; value: number }[]
  byCampaign:  { label: string; value: number }[]
  byTier:      { label: string; value: number }[]
  health:      HealthIndicator[]
}

export interface LicenseCenterOverviewResponse { overview: LicenseCenterOverview }

// ─── Coupons ──────────────────────────────────────────────────────────────────
// A client-safe VIEW over the fields the existing coupon routes already return as
// primitives / ISO strings (createdAt/updatedAt Timestamps are intentionally NOT
// surfaced — the console never renders them). Consumed via the EXISTING routes:
//   GET  /api/admin/license-coupons          → { coupons: CouponView[] }
//   GET  /api/admin/license-coupons/[code]   → { coupon, usage }
//   POST /api/admin/license-coupons          → create
//   POST /api/admin/license-coupons/[code]   → update | clone | pause | resume | archive

export interface CouponView {
  code:              string
  description:       string
  type:              LicenseCouponType
  value:             number
  lifecycle:         LicenseCouponLifecycle
  maxDiscountPaise:  number | null
  minPurchasePaise:  number | null
  maxPurchasePaise:  number | null
  activatesAt:       string | null
  expiresAt:         string | null
  usageLimit:        number | null
  perOrganizerLimit: number | null
  currentUses:       number
  restrictions:      { tiers: EventLicenseTier[]; eventTypes: string[] }
  enabled:           boolean
  paused:            boolean
  archived:          boolean
  visibility:        'public' | 'private'
  campaign:          string
  internalNotes:     string
  priority:          number
  stackable:         boolean
}

export interface CouponListResponse { coupons: CouponView[] }

export interface CouponUsageView { currentUses: number; paidRedemptions: number; discountGivenPaise: number }

export interface CouponDetailResponse { coupon: CouponView; usage: CouponUsageView }

// ─── Timeline ─────────────────────────────────────────────────────────────────

export type CenterTimelineSource = 'license' | 'coupon' | 'audit' | 'billing'

export interface LicenseCenterTimelineEntry {
  id:     string
  source: CenterTimelineSource
  action: string
  detail: string
  actor:  string | null
  entity: string | null   // eventId / coupon code / etc.
  at:     string | null
}

export interface LicenseCenterTimelineResponse { entries: LicenseCenterTimelineEntry[] }
