// Client-safe types for the Enterprise Operations Center / NOC (GA-2 S4).
// NO firebase-admin / server imports — shared by the page and the API layer.
//
// READ-first over thin admin endpoints that REUSE the existing generic job engine
// (lib/jobs) and every feature job type. The ONLY mutation surfaced is CANCEL, which
// reuses the kernel's existing cancelJob(); there is NO generic retry/restart engine,
// so those are honestly reported as unsupported. No new queue, no new job engine.

import type { JobStatus } from '@/lib/jobs/types'

export type { JobStatus }

// ─── Engines (each maps to one or more existing job collections) ─────────────

export type EngineKey = 'print' | 'certificate' | 'import' | 'export' | 'broadcast' | 'bulk'

// ─── Health Panel ───────────────────────────────────────────────────────────

export type HealthLevel = 'green' | 'yellow' | 'red' | 'neutral'
export type HealthKey = EngineKey | 'queue'

export interface HealthIndicator {
  key:    HealthKey
  label:  string
  level:  HealthLevel
  detail: string
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export interface EngineStatus {
  key:       EngineKey
  label:     string
  total:     number
  running:   number   // processing
  waiting:   number   // pending
  failed:    number
  completed: number
  cancelled: number
}

export interface JobStatusRollup {
  total: number; running: number; waiting: number; failed: number; completed: number; cancelled: number
}

export interface OpsOverview {
  engines: EngineStatus[]
  overall: JobStatusRollup
  health:  HealthIndicator[]
}

export interface OpsOverviewResponse { overview: OpsOverview }

// ─── Jobs (Operations / Failures workspaces) ────────────────────────────────

export interface OpsJobView {
  jobId:        string
  collection:   string
  engine:       EngineKey
  engineLabel:  string
  status:       JobStatus
  total:        number
  processed:    number
  succeeded:    number
  failed:       number
  error:        string | null
  organizerUid: string | null
  eventId:      string | null
  campaignId:   string | null
  createdAt:    string | null
  startedAt:    string | null
  completedAt:  string | null
  durationMs:   number | null
  cancellable:  boolean   // reuses kernel cancelJob (non-terminal states)
  retrySupported: boolean // always false today — no retry engine exists
}

export interface OpsJobsResponse { jobs: OpsJobView[]; truncated: boolean }

// ─── Monitoring ─────────────────────────────────────────────────────────────

export interface EngineMonitoring {
  key:              EngineKey
  label:            string
  sampled:          number
  completed:        number
  failed:           number
  running:          number
  successRatePct:   number | null
  failureRatePct:   number | null
  avgDurationMs:    number | null
  throughputPerDay: number   // jobs created in the last 24h within the sample
}

export interface OpsMonitoring { engines: EngineMonitoring[]; sampleSize: number }
export interface OpsMonitoringResponse { monitoring: OpsMonitoring }

// ─── Timeline (Audit workspace) ─────────────────────────────────────────────

export type OpsTimelineKind = 'created' | 'completed' | 'failed' | 'cancelled' | 'admin'

export interface OpsTimelineEntry {
  id:     string
  engine: EngineKey | 'admin'
  kind:   OpsTimelineKind
  detail: string
  entity: string | null   // eventId / campaignId / owner
  jobId:  string | null
  at:     string | null
}

export interface OpsTimelineResponse { entries: OpsTimelineEntry[] }

// ─── Cancel (reuses kernel cancelJob) ────────────────────────────────────────

export interface OpsCancelResponse { jobId: string; status: JobStatus | null }
