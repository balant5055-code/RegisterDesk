// RD-PLATFORM-COMMS-01 Phase 4H — canonical Communication Insight types (isomorphic).
//
// Insights are a READ-ONLY derivation over Analytics + Health + Registry + Templates.
// Analytics consumes the Timeline; the Timeline remains the operational source of truth.
// Every insight traces to a real condition — none are fabricated.

export type InsightCategory =
  | 'configuration' | 'templates' | 'providers' | 'notifications' | 'delivery'
  | 'health' | 'performance' | 'compliance' | 'security' | 'recommendation'

export type InsightSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational'

/** Read-only lifecycle. Today every generated insight is 'open' (no ack storage yet);
 *  'future' marks reserved/forward-looking suggestions. Acknowledge/Resolve/Suppress are the
 *  reserved states a later phase will persist — this phase never mutates status. */
export type InsightStatus = 'open' | 'acknowledged' | 'resolved' | 'suppressed' | 'future'

export interface CommunicationInsight {
  insightId:           string        // deterministic (rule + related object)
  category:            InsightCategory
  severity:            InsightSeverity
  status:              InsightStatus
  title:               string
  description:         string
  recommendation:      string
  relatedNotification: string | null
  relatedTemplate:     string | null
  relatedProvider:     string | null
  relatedChannel:      string | null
  generatedAt:         string        // ISO — supplied by the resolver (deterministic input)
  metadata:            Record<string, string | number | undefined>
  // Reserved forward-looking flags (Phase 4I+). Not active controls.
  futureRule:          boolean
  futureAutomation:    boolean
  futureWorkflow:      boolean
}

export interface InsightFilters {
  severity?:     InsightSeverity
  category?:     InsightCategory
  provider?:     string
  notification?: string
  status?:       InsightStatus
}

// ─── Future extension points (Phase 4I+) — RESERVED, NOT IMPLEMENTED ──────────
export interface InsightExtensionPoints {
  campaignOptimizer?: never
  rulesEngine?:       never
  replay?:            never
  aiAssistant?:       never
  autoRemediation?:   never
}
