// Client-safe types for the Organizer License Center (RD-LIC-ORG-01).
// NO server imports — shared by the detail API route and the page.

import type { EventLicenseTier, EventLicenseFeature } from '@/lib/licensing/eventLicense'

export type LicenseCenterStatus = 'active' | 'pending' | 'suspended' | 'cancelled'
export type LicenseCenterPayment = 'paid' | 'pending' | 'failed' | 'refunded' | 'free' | 'complimentary'

// One row of the effective feature matrix, straight from resolveEffectiveEventLicense.
export interface LicenseFeatureCell {
  key:         EventLicenseFeature
  label:       string
  included:    boolean   // effective entitlement (tier + config + admin overlay)
  overridden:  boolean   // admin overrode this feature for the event
  adminGranted: boolean  // overridden ON while the base tier had it OFF
}

export interface LicenseTimelineItem {
  id:        string
  action:    string   // raw history action
  label:     string   // organizer-friendly label
  createdAt: string | null   // ISO
  bySystem:  boolean   // true when source !== 'self_serve' (admin/system)
}

export interface LicenseBilling {
  orderId:           string | null
  status:            string          // order status (created/paid/failed/refunded) or 'free'/'complimentary'
  amountPaise:       number          // total charged
  walletUsedPaise:   number
  gatewayPaise:      number          // amount charged to Razorpay (amount - wallet)
  razorpayPaymentId: string | null
  date:              string | null   // ISO
}

export interface LicenseUpgradeOption {
  nextTier:               EventLicenseTier
  nextTierName:           string
  currentPricePaise:      number
  nextPricePaise:         number
  priceDifferencePaise:   number
  benefits:               string[]   // nextTier featureList bullets
}

export interface LicenseCenterDetail {
  eventId:      string
  eventName:    string
  eventStatus:  string | null

  tier:         EventLicenseTier
  tierName:     string
  status:       LicenseCenterStatus
  payment:      LicenseCenterPayment
  complimentary: boolean
  hasOverrides: boolean

  // Registration usage
  registrationLimit:     number | null   // effective (null = unlimited)
  baseRegistrationLimit: number | null   // tier default, for original-vs-override display
  limitOverridden:       boolean
  used:                  number
  remaining:             number | null

  // Pricing
  amountPaidPaise:     number
  effectivePricePaise: number
  purchaseDate:        string | null

  features: LicenseFeatureCell[]
  timeline: LicenseTimelineItem[]
  billing:  LicenseBilling
  upgrade:  LicenseUpgradeOption | null   // null when Enterprise / not upgradable
}

// Human labels for the boolean feature entitlements.
export const FEATURE_LABELS: Record<EventLicenseFeature, string> = {
  offlineCheckin:  'Offline check-in',
  teamAccess:      'Team access',
  apiAccess:       'API access',
  whiteLabel:      'White label',
  customDomain:    'Custom domain',
  advancedReports: 'Advanced reports',
  prioritySupport: 'Priority support',
}
