// Client-safe types for the Enterprise Organizer 360 Console (GA-2 S2).
// NO firebase-admin / server imports — shared by the page and the API layer.
//
// The console is READ-ONLY over five thin admin-gated endpoints:
//   GET …/360        → overview + permanent health (loads first)
//   GET …/operations → events + counters + certificates/comms/jobs (lazy)
//   GET …/business   → licenses + coupons + wallet + settlements + entitlements (lazy)
//   GET …/governance → audit + entitlements/overrides + team permissions (lazy)
//   GET …/timeline   → merged chronological trail (lazy)
// All MUTATIONS reuse existing admin routes — no new mutation logic here.

import type { EventLicenseTier } from '@/lib/licensing/eventLicense'
import type { AccountStatus } from '@/lib/admin/organizerTypes'

// ─── Health Panel ───────────────────────────────────────────────────────────

export type HealthLevel = 'green' | 'yellow' | 'red' | 'neutral'

export type HealthKey =
  | 'account' | 'verification' | 'licenses' | 'events'
  | 'payments' | 'communications' | 'jobs' | 'storage'

export interface HealthIndicator {
  key:    HealthKey
  label:  string
  level:  HealthLevel
  detail: string
}

// ─── Overview payload (/360) ────────────────────────────────────────────────

export interface Organizer360Overview {
  uid: string
  profile: {
    name:             string
    email:            string
    organizationName: string
    role:             string
    phone:            string | null
    createdAt:        string | null
  }
  account: {
    status:          AccountStatus
    statusReason:    string | null
    statusUpdatedAt: string | null
    statusUpdatedBy: string | null
  }
  verification: {
    emailVerified:  boolean
    payoutExists:   boolean
    payoutVerified: boolean
    payoutMethod:   'bank' | 'upi' | null
  }
  team: { memberCount: number; inviteCount: number }
  entitlements: {
    effectiveTier:        EventLicenseTier
    source:               'event_license' | 'admin_override' | 'fallback'
    activeLicensedEvents: number
    overrideTier:         EventLicenseTier | null
  }
  events: { total: number; published: number; campaigns: number }
  registrations: { total: number; checkedIn: number; sampledEvents: number; truncated: boolean }
  revenue: {
    walletExists:   boolean
    availablePaise: number
    pendingPaise:   number
    inTransitPaise: number
    settledPaise:   number
  }
  licenses: { total: number; active: number; revenuePaise: number }
  health: HealthIndicator[]
}

export interface Organizer360Response { overview: Organizer360Overview }

// ─── Operations payload (/operations) ───────────────────────────────────────

export interface Organizer360Event {
  slug:             string
  name:             string
  lifecycleStatus:  string | null
  reviewStatus:     string | null
  moderationStatus: string | null
  licenseTier:      string | null
  licenseStatus:    string | null
  registrations:    number
  checkedIn:        number
  revenuePaise:     number
}

export interface Organizer360Operations {
  events:    Organizer360Event[]
  truncated: boolean
  certificates:   { issued: number; approxOfEvents: number }
  communications: { sent: number; failed: number; approxOfEvents: number }
  jobs:           { total: number; running: number; failed: number; recent: Organizer360Job[] }
}

export interface Organizer360Job {
  id:         string
  collection: string
  kind:       string
  status:     string
  createdAt:  string | null
}

// ─── Business payload (/business) ───────────────────────────────────────────

export interface Organizer360License {
  eventId:         string
  eventName:       string
  tier:            string
  displayStatus:   string
  paymentStatus:   string
  amountPaidPaise: number
  couponCode:      string | null
  purchaseDate:    string | null
}

export interface Organizer360Business {
  licenses:  Organizer360License[]
  truncated: boolean
  coupons:   { code: string; count: number; discountPaise: number }[]
  wallet: {
    walletExists:   boolean
    availablePaise: number
    pendingPaise:   number
    inTransitPaise: number
    settledPaise:   number
  }
  payout: { exists: boolean; verified: boolean; method: 'bank' | 'upi' | null; verifiedAt: string | null }
  settlements: { id: string; amountPaise: number; status: string; requestedAt: string | null }[]
  revenue: { licenseRevenuePaise: number; eventRevenuePaise: number }
  entitlements: {
    effectiveTier:        EventLicenseTier
    source:               string
    activeLicensedEvents: number
    features:             { key: string; enabled: boolean }[]
    limits:               { key: string; value: number }[]
  }
}

// ─── Governance payload (/governance) ───────────────────────────────────────

export interface Organizer360AuditEntry {
  id:       string
  action:   string
  entityType: string
  detail:   string
  actor:    string | null
  at:       string | null
}

export interface Organizer360TeamMember {
  id:         string
  name:       string
  email:      string
  role:       string
  status:     string
  permissions: number
}

export interface Organizer360Governance {
  audit:       Organizer360AuditEntry[]
  overrides:   { entitlementOverrideTier: EventLicenseTier | null; source: string; effectiveTier: EventLicenseTier }
  features:    { key: string; enabled: boolean }[]
  team:        Organizer360TeamMember[]
}

// ─── Timeline payload (/timeline) ───────────────────────────────────────────

export type OrgTimelineSource =
  | 'account' | 'verification' | 'license' | 'coupon' | 'event'
  | 'payment' | 'audit' | 'override'

export interface Organizer360TimelineEntry {
  id:     string
  source: OrgTimelineSource
  action: string
  detail: string
  actor:  string | null
  at:     string | null
}

export interface Organizer360Timeline { entries: Organizer360TimelineEntry[] }
