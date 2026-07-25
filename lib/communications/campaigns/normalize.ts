// RD-PLATFORM-COMMS-02 Phase 5A — the pure Campaign normalizer/resolver (isomorphic).
//
// The ONE place a raw campaign record becomes a ResolvedCampaign. PURE — validates enums,
// fills safe defaults, and derives display labels + lifecycle flags. No I/O, no mutation, no
// execution. Returns null for a record without a usable id/name (never fabricates a campaign).

import {
  CAMPAIGN_STATUSES, CAMPAIGN_TYPES, CAMPAIGN_CATEGORIES,
  type Campaign, type ResolvedCampaign, type CampaignStatus, type CampaignType, type CampaignCategory, type CampaignPriority,
} from './types'

const TERMINAL: CampaignStatus[] = ['completed', 'cancelled', 'archived']
const ACTIVE:   CampaignStatus[] = ['scheduled', 'running', 'paused']

function titleize(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function strOrNull(v: unknown): string | null { return typeof v === 'string' && v ? v : null }

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

/** Normalize a raw campaign record (e.g. a Firestore doc) into a Campaign. PURE. */
export function normalizeCampaign(raw: Record<string, unknown>): Campaign | null {
  const campaignId = str(raw.campaignId) || str(raw.id)
  const name       = str(raw.name)
  if (!campaignId || !name) return null   // not a usable campaign — never fabricated

  return {
    campaignId,
    name,
    description:    str(raw.description),
    type:          oneOf<CampaignType>(raw.type, CAMPAIGN_TYPES, 'announcement'),
    category:      oneOf<CampaignCategory>(raw.category, CAMPAIGN_CATEGORIES, 'platform'),
    status:        oneOf<CampaignStatus>(raw.status, CAMPAIGN_STATUSES, 'draft'),
    priority:      oneOf<CampaignPriority>(raw.priority, ['high', 'medium', 'low'], 'medium'),
    notificationId: strOrNull(raw.notificationId),
    templateId:     strOrNull(raw.templateId),
    policyId:       strOrNull(raw.policyId),
    audienceId:     strOrNull(raw.audienceId),
    createdBy:      str(raw.createdBy),
    createdAt:      str(raw.createdAt),
    updatedAt:      str(raw.updatedAt),
    scheduledAt:    strOrNull(raw.scheduledAt),
    startedAt:      strOrNull(raw.startedAt),
    completedAt:    strOrNull(raw.completedAt),
    cancelledAt:    strOrNull(raw.cancelledAt),
    metadata:       (raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}) as Campaign['metadata'],
  }
}

/** Enrich a Campaign with display labels + lifecycle flags. PURE. */
export function resolveCampaign(c: Campaign): ResolvedCampaign {
  return {
    ...c,
    statusLabel:   titleize(c.status),
    typeLabel:     titleize(c.type),
    categoryLabel: titleize(c.category),
    isTerminal:    TERMINAL.includes(c.status),
    isActive:      ACTIVE.includes(c.status),
  }
}
