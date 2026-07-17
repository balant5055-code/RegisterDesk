// Client-safe types for the Enterprise Event 360 Console (GA-2 S1).
// NO firebase-admin / server imports — shared by the page and the API layer.
//
// The console is READ-ONLY over four thin admin-gated endpoints:
//   GET …/360        → overview + permanent health (O(1) counters, loads first)
//   GET …/analytics  → per-event analytics (Operations + Business, lazy)
//   GET …/governance → publish baseline + license overlay (Governance, lazy)
//   GET …/timeline   → merged chronological trail (Governance, lazy)
// All MUTATIONS reuse existing admin routes — no new mutation logic here.

import type { EventAnalytics } from '@/lib/analytics/eventAnalytics'
import type { LicenseDetail } from '@/lib/admin/licenseAdminTypes'

// ─── Health Panel ───────────────────────────────────────────────────────────
// A permanent green/yellow/red (+neutral “not yet evaluated”) strip. The core
// four indicators (License, Payments, Registrations, Attendance) are derived
// from O(1) counters + the license row in /360 and shown immediately. The
// heavier ones (Certificates, Communications, Analytics) start `neutral` and are
// upgraded client-side once the analytics endpoint is fetched — reusing that one
// bounded query rather than adding a new scan. Print stays `neutral` (its signal
// lives in its own workspace).

export type HealthLevel = 'green' | 'yellow' | 'red' | 'neutral'

export type HealthKey =
  | 'license' | 'payments' | 'registrations' | 'attendance'
  | 'certificates' | 'print' | 'communications' | 'analytics'

export interface HealthIndicator {
  key:    HealthKey
  label:  string
  level:  HealthLevel
  detail: string
}

// ─── Overview payload (/360) ────────────────────────────────────────────────

export interface Event360Overview {
  slug:            string
  eventName:       string
  tagline:         string
  eventType:       string | null
  lifecycleStatus: string | null   // published / pending_review / draft / …
  reviewStatus:    string | null
  moderationStatus: string | null
  organizer: {
    uid:       string
    name:      string | null
    email:     string | null
    workspace: string | null
    phone:     string | null
  }
  schedule: {
    startDate: string | null
    startTime: string | null
    endDate:   string | null
    timezone:  string | null
  }
  venue: {
    type:  string | null
    name:  string | null
    city:  string | null
    state: string | null
  }
  license: {
    tier:              string | null
    displayStatus:     string | null
    paymentStatus:     string | null
    registrationLimit: number | null
    used:              number
    amountPaidPaise:   number
    hasOverrides:      boolean
    complimentary:     boolean
    expiresAt:         string | null
    consumed:          boolean
  } | null
  coupon: {
    code:            string | null
    campaign:        string | null
    discountPaise:   number
    finalPricePaise: number | null
  } | null
  counters: {
    totalRegistrations: number
    checkedIn:          number
    revenuePaise:       number
    pending:            number
    cancelled:          number
    statsComplete:      boolean
  }
  lifecycle: {
    createdAt:   string | null
    publishedAt: string | null
    approvedAt:  string | null
  }
  health: HealthIndicator[]
}

export interface Event360Response {
  overview: Event360Overview
}

// ─── Analytics payload (/analytics) — Operations + Business ─────────────────

export interface Event360Analytics {
  analytics: EventAnalytics
}

// ─── Governance payload (/governance) ───────────────────────────────────────

export interface GovernanceBaselineView {
  eventId:         string          // draftId
  firstPublishedAt: string | null
  publishCount:    number
  identity: {
    name:    string | null
    city:    string | null
    startDate: string | null
    eventType: string | null
  } | null
  overrides: {
    publish:            boolean
    identity:           boolean
    registrationSafety: boolean
  }
}

export interface Event360Governance {
  baseline: GovernanceBaselineView | null
  license:  LicenseDetail | null
}

// ─── Timeline payload (/timeline) — merged chronological trail ──────────────

export type TimelineSource =
  | 'lifecycle' | 'audit' | 'license' | 'governance' | 'moderation'

export interface Event360TimelineEntry {
  id:       string
  source:   TimelineSource
  action:   string
  detail:   string
  actor:    string | null
  at:       string | null   // ISO
}

export interface Event360Timeline {
  entries: Event360TimelineEntry[]
}
