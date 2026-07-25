// RD-PLATFORM-COMMS-02 Phase 5C — canonical Campaign Composer types (isomorphic).
//
// The Composer assembles a CampaignDraft from the existing platform domains (Campaign Registry,
// Audience Builder, Communication Registry, Templates, Variables, Policy, Health). READ-ONLY —
// nothing is persisted, executed, scheduled, or sent. The draft is an ephemeral projection.

import type { ResolvedNotificationPolicy } from '@/lib/communications/policy/resolve'
import type { TemplateChannel } from '@/lib/communications/templates/registry'
import type { CampaignType, CampaignCategory } from '@/lib/communications/campaigns/types'

export interface ComposerInput {
  notificationId: string
  channel:        TemplateChannel
  audienceId?:    string
  name?:          string
  type?:          CampaignType
  category?:      CampaignCategory
}

export interface ComposerVariable {
  id:     string
  token:  string
  label:  string
  sample: string
  known:  boolean
}

export interface ComposerValidation {
  check:  'campaign' | 'audience' | 'notification' | 'template' | 'variables' | 'policy' | 'channel'
  ok:     boolean
  detail: string
}

export interface CampaignDraft {
  draftId:  string       // deterministic, ephemeral — NOT persisted
  campaign: { name: string; type: CampaignType; category: CampaignCategory }
  channel:  TemplateChannel
  audience: {
    audienceId: string; name: string; type: string; scope: string
    ruleCount: number; estimatedReach: number | null; health: string; valid: boolean
  } | null
  notification: {
    id: string; displayName: string; category: string; priority: string
    supportedChannels: string[]; templateAvailable: boolean
  } | null
  template: { templateId: string; channel: string; status: string; version: number } | null
  policy:   ResolvedNotificationPolicy | null
  variables: ComposerVariable[]
  validation: ComposerValidation[]
  createdBy: string
  createdAt: string
  metadata:  Record<string, string | number | boolean | undefined>
}

// ─── Future extension points (Phase 5D+) — RESERVED, NOT IMPLEMENTED ──────────
export interface ComposerExtensionPoints {
  approvalWorkflow?: never
  executionPlanner?: never
  scheduling?:       never
  timeline?:         never
  analytics?:        never
  insights?:         never
  rulesEngine?:      never
  replay?:           never
  ai?:               never
}
