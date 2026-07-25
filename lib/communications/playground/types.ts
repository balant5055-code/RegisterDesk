// RD-PLATFORM-COMMS-01 Phase 4I — Communication Playground types (isomorphic).
//
// The Playground is a READ-ONLY QA composition of the canonical resolvers for a single chosen
// notification + channel. Nothing is persisted, nothing is sent — every field is a PROJECTION
// resolved through the existing Registry / Policy / Template / Analytics / Insight resolvers.

import type { TemplateChannel } from '@/lib/communications/templates/registry'
import type { ResolvedNotificationPolicy } from '@/lib/communications/policy/resolve'
import type { CommMetrics } from '@/lib/communications/analytics/types'
import type { CommunicationInsight } from '@/lib/communications/insights/types'
import type { TimelineStatus } from '@/lib/communications/timeline/types'

export interface PlaygroundInput {
  notificationId: string
  channel:        TemplateChannel
}

export interface PlaygroundVariable {
  id:      string
  token:   string
  label:   string
  sample:  string
  known:   boolean   // exists in the canonical variable registry (unknown ⇒ validation fails)
}

export interface PlaygroundValidation {
  check:  'registry' | 'policy' | 'template' | 'binding' | 'channel' | 'variables' | 'provider'
  ok:     boolean
  detail: string
}

export interface TimelineStageProjection {
  stage:     TimelineStatus
  reachable: boolean
  note:      string
}

export interface PlaygroundSession {
  notificationId: string
  channel:        TemplateChannel
  found:          boolean
  registry: {
    category: string; displayName: string; description: string; trigger: string; audience: string
  } | null
  supports:  { email: boolean; whatsapp: boolean; inapp: boolean; sms: boolean; push: boolean }
  policy:    ResolvedNotificationPolicy | null
  template:  { templateId: string; status: string; version: number; variables: PlaygroundVariable[] } | null
  validation:          PlaygroundValidation[]
  timelineProjection:  TimelineStageProjection[]
  analyticsProjection: CommMetrics
  insightProjection:   CommunicationInsight[]
}

// ─── Future extension points (Phase 4J+) — RESERVED, NOT IMPLEMENTED ──────────
export interface PlaygroundExtensionPoints {
  campaignPreview?: never
  rulesPreview?:    never
  replayPreview?:   never
  aiReview?:        never
}
