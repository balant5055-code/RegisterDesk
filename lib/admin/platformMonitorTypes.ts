// Client-safe types for the Enterprise Platform Monitoring Dashboard (GA-2 S5).
// NO firebase-admin / server imports — shared by the page and the API layer.
//
// The dashboard is a COMPOSITION over existing data. Three thin new aggregators
// (overview / services / security) plus REUSE of existing endpoints from the client:
//   Infrastructure → GET /api/admin/operations            (getOperationsHealth)
//   Performance    → GET /api/admin/operations-center/monitoring + /api/admin/analytics
//   Observability  → GET /api/admin/operations-center/timeline
// HONESTY RULE: a metric that cannot be derived is null → the UI shows "Unavailable".
// Never estimated, never fabricated. No new monitoring engine.

// ─── Health Panel ───────────────────────────────────────────────────────────

export type HealthLevel = 'green' | 'yellow' | 'red' | 'neutral'
export type HealthKey =
  | 'platform' | 'payments' | 'communications' | 'operations'
  | 'security' | 'licensing' | 'storage' | 'infrastructure'

export interface HealthIndicator {
  key:    HealthKey
  label:  string
  level:  HealthLevel
  detail: string
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export interface PlatformKpis {
  activeOrganizers:  number
  activeEvents:      number
  registrationsToday: number | null   // null ⇒ Unavailable
  paymentsToday:      number | null
  revenueTodayPaise:  number | null
  lifetimeRevenuePaise: number
  runningJobs:        number
  failedJobs:         number
}

export interface PlatformAlert { id: string; severity: 'critical' | 'warning' | 'info'; message: string }

export interface PlatformOverview {
  kpis:    PlatformKpis
  health:  HealthIndicator[]
  version: string | null   // null ⇒ Unavailable (never fabricated)
}

export interface PlatformOverviewResponse { overview: PlatformOverview }

// ─── Services ─────────────────────────────────────────────────────────────────

export type ServiceLevel = 'healthy' | 'warning' | 'unavailable'

export interface ServiceHealth {
  key:    string
  label:  string
  level:  ServiceLevel
  detail: string
  metric: string | null   // headline number/label, or null when Unavailable
}

export interface PlatformServices { services: ServiceHealth[] }
export interface PlatformServicesResponse { services: ServiceHealth[] }

// ─── Security ─────────────────────────────────────────────────────────────────

export interface SecurityAuditEntry {
  id:         string
  action:     string
  entityType: string
  entityId:   string | null
  actor:      string | null
  reason:     string | null
  at:         string | null
}

export interface PlatformSecurity {
  auditHealth: {
    last24h:      number
    lastEntryAt:  string | null
    writing:      boolean
  }
  counts: { total: number; overrides: number; moderation: number; finance: number }
  recentActivity: SecurityAuditEntry[]
  overrides:      SecurityAuditEntry[]   // permission / license / coupon / plan overrides
}

export interface PlatformSecurityResponse { security: PlatformSecurity }
