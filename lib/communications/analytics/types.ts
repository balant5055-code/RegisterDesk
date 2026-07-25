// RD-PLATFORM-COMMS-01 Phase 4G — canonical Communication Analytics types (isomorphic).
//
// Analytics is a READ-ONLY projection over the Timeline (Phase 4F) — never over providers.
// The Timeline is the operational source of truth; these types describe the aggregated view.

/** Base metric bundle, reused across every breakdown. */
export interface CommMetrics {
  volume:        number
  accepted:      number   // provider-accepted (sent / delivered / opened / clicked)
  delivered:     number   // delivered / opened / clicked
  opened:        number   // opened / clicked
  clicked:       number
  failed:        number
  cancelled:     number   // cancelled / expired
  retrying:      number
  queued:        number
  avgLatencyMs:  number | null
  lastAt:        string | null   // most recent activity (ISO)
}

export interface RateMetrics extends CommMetrics {
  successRate: number   // accepted / volume (0..1)
  failureRate: number   // failed / volume (0..1)
}

export interface ProviderAnalytics {
  provider:          string
  implemented:       boolean
  metrics:           CommMetrics
  availability:      number                     // accepted / (accepted + failed), 0..1
  errorDistribution: { code: string; count: number }[]
}

export interface NamedMetrics { key: string; label: string; metrics: CommMetrics }

export interface NotificationAnalytics {
  notificationId: string
  displayName:    string
  category:       string
  metrics:        CommMetrics
}

export interface TemplateAnalytics {
  templateId:        string
  boundNotification: string | null
  metrics:           CommMetrics
}

export interface CommunicationAnalytics {
  scanned:        number   // timeline rows aggregated (honest — analytics is not exhaustive)
  overall:        RateMetrics
  byProvider:     ProviderAnalytics[]
  byChannel:      NamedMetrics[]
  byCategory:     NamedMetrics[]
  byNotification: NotificationAnalytics[]
  byTemplate:     TemplateAnalytics[]
}

// ─── Future extension points (Phase 4H+) — RESERVED, NOT IMPLEMENTED ──────────
export interface AnalyticsExtensionPoints {
  campaignAnalytics?:      never   // per-campaign rollups
  communicationInsights?:  never   // derived insights / anomalies
  replay?:                 never   // re-dispatch from analytics context
  rulesEngine?:            never   // trigger on analytics thresholds
  aiRecommendations?:      never   // AI-suggested actions
}
