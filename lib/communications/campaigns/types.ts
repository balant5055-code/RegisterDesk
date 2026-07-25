// RD-PLATFORM-COMMS-02 Phase 5A — canonical Campaign domain types (isomorphic).
//
// A Campaign is a first-class PLATFORM object (RegisterDesk → Organizer). This phase builds the
// REGISTRY only — no execution, no sending, no scheduling, no queues. Distinct from the existing
// lib/broadcasts (organizer → attendee, which executes) — that subsystem is untouched.

export type CampaignStatus =
  | 'draft' | 'review' | 'approved' | 'scheduled' | 'running'
  | 'paused' | 'completed' | 'cancelled' | 'archived'

export const CAMPAIGN_STATUSES: CampaignStatus[] = ['draft', 'review', 'approved', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'archived']

export type CampaignType =
  | 'broadcast' | 'maintenance' | 'feature_release' | 'license' | 'billing'
  | 'security' | 'system' | 'reminder' | 'announcement' | 'marketing'

export const CAMPAIGN_TYPES: CampaignType[] = ['broadcast', 'maintenance', 'feature_release', 'license', 'billing', 'security', 'system', 'reminder', 'announcement', 'marketing']

export type CampaignCategory =
  | 'platform' | 'organizer' | 'compliance' | 'operations' | 'product' | 'finance' | 'security' | 'marketing'

export const CAMPAIGN_CATEGORIES: CampaignCategory[] = ['platform', 'organizer', 'compliance', 'operations', 'product', 'finance', 'security', 'marketing']

export type CampaignPriority = 'high' | 'medium' | 'low'

/** The persisted campaign record (the Composer, a future phase, will create these). */
export interface Campaign {
  campaignId:     string
  name:           string
  description:    string
  type:           CampaignType
  category:       CampaignCategory
  status:         CampaignStatus
  priority:       CampaignPriority
  notificationId: string | null   // bound platform notification (Registry, 4C)
  templateId:     string | null   // bound platform template (Template Center, 4E)
  policyId:       string | null   // bound notification policy (Policy Center, 4D)
  audienceId:     string | null   // reserved — the Audience Builder is a future phase
  createdBy:      string
  createdAt:      string          // ISO
  updatedAt:      string          // ISO
  scheduledAt:    string | null
  startedAt:      string | null
  completedAt:    string | null
  cancelledAt:    string | null
  metadata:       Record<string, string | number | boolean | undefined>
}

/** A campaign normalized + enriched with display + lifecycle flags. */
export interface ResolvedCampaign extends Campaign {
  statusLabel:   string
  typeLabel:     string
  categoryLabel: string
  isTerminal:    boolean   // completed / cancelled / archived
  isActive:      boolean   // scheduled / running / paused
}

// ─── Future extension points (Phase 5B+) — RESERVED, NOT IMPLEMENTED ──────────
export interface CampaignExtensionPoints {
  audienceBuilder?: never
  composer?:        never
  approval?:        never
  execution?:       never
  timeline?:        never
  analytics?:       never
  insights?:        never
  rulesEngine?:     never
  replay?:          never
}
