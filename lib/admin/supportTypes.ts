// Client-safe types for the Enterprise Support Workspace (GA-2 S7).
// NO firebase-admin / server imports.
//
// The support workspace is a REUSE-only consolidation: search reuses the global
// search hook, recent activity reuses the Operations Center + Platform Monitor
// timelines, and this overview reuses bounded count()/recent reads. No new data.

export interface SupportOrganizer {
  uid:       string
  name:      string
  email:     string
  status:    string
  createdAt: string | null
}

export interface SupportEvent {
  slug:         string
  name:         string
  status:       string | null
  organizerUid: string | null
}

export interface SupportHealth {
  approvalsPending:    number
  moderationPending:   number
  failedJobs:          number
  expiredLicenses:     number
  suspendedOrganizers: number
  paymentIssues:       number
}

export interface SupportOverview {
  recentOrganizers: SupportOrganizer[]
  recentEvents:     SupportEvent[]
  health:           SupportHealth
}

export interface SupportOverviewResponse { overview: SupportOverview }
