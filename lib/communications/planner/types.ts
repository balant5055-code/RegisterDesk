// RD-PLATFORM-COMMS-02 Phase 5E — canonical Campaign Execution Plan types (isomorphic).
//
// The planner produces a deterministic, READ-ONLY execution PLAN by composing existing canonical
// resolvers. Nothing executes, schedules, queues, dispatches, or persists — every number is a
// projection.

import type { CampaignLifecycleState } from '@/lib/communications/approval/types'

/** Batch size used for batch projection (projection only — no queue is built). */
export const PLAN_BATCH_SIZE = 500

export interface ChannelProjection {
  channel:   'email' | 'whatsapp' | 'inapp' | 'sms' | 'push'
  supported: boolean
  reason:    string
}

export interface ProviderReadiness {
  provider:  string
  channel:   string
  ready:     boolean
  state:     string
  detail:    string
}

export interface WalletReadiness {
  balancePaise:      number | null   // null: no single wallet applies (platform → organizer)
  estimatedCostPaise: number
  sufficient:        boolean | null  // null when balance is not applicable
  notes:             string
}

export interface AudienceProjection {
  audienceId:     string
  name:           string
  scope:          string
  ruleCount:      number
  estimatedReach: number | null      // null until the audience has been evaluated
  health:         string
  valid:          boolean
}

export interface PlanValidation {
  check:  'campaign' | 'approval' | 'audience' | 'templates' | 'variables' | 'policy' | 'providers' | 'wallet'
  ok:     boolean
  detail: string
}

export interface ExecutionPlan {
  planId:              string   // deterministic, ephemeral
  campaignId:          string
  campaignName:        string | null
  approvalState:       CampaignLifecycleState
  audience:            AudienceProjection | null
  estimatedRecipients: number | null
  estimatedChannels:   ChannelProjection[]
  estimatedMessages:   number | null
  estimatedBatches:    number | null
  batchSize:           number
  estimatedCostPaise:  number | null
  providerReadiness:   ProviderReadiness[]
  walletReadiness:     WalletReadiness
  validation:          PlanValidation[]
  generatedAt:         string
  metadata:            Record<string, string | number | boolean | undefined>
}

// ─── Future extension points (Phase 5F+) — RESERVED, NOT IMPLEMENTED ──────────
export interface PlannerExtensionPoints {
  executionEngine?:  never
  queueBuilder?:     never
  scheduler?:        never
  retryEngine?:      never
  timelineWriter?:   never
  analyticsWriter?:  never
  insightsWriter?:   never
  replay?:           never
  ai?:               never
}
