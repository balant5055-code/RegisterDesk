// RD-PLATFORM-COMMS-01 Phase 4F — canonical Communication Timeline types (isomorphic).
//
// ONE historical shape for every platform communication event. READ-ONLY + append-only: the
// timeline never mutates, replays, resends, or retries — it only records what already happened,
// sourced from the existing emailLogs collection. No new storage, no behavior change.

/** Canonical delivery lifecycle. A superset of what any single provider reports today; states
 *  a provider does not emit (accepted/clicked/retrying/expired) simply never appear yet. */
export type TimelineStatus =
  | 'queued' | 'accepted' | 'sent' | 'delivered' | 'opened' | 'clicked'
  | 'failed' | 'retrying' | 'cancelled' | 'expired' | 'unknown'

export const TIMELINE_STATUS_LABELS: Record<TimelineStatus, string> = {
  queued: 'Queued', accepted: 'Accepted', sent: 'Sent', delivered: 'Delivered',
  opened: 'Opened', clicked: 'Clicked', failed: 'Failed', retrying: 'Retrying',
  cancelled: 'Cancelled', expired: 'Expired', unknown: 'Unknown',
}

export type TimelineChannel = 'email' | 'whatsapp' | 'inapp' | 'sms' | 'push'
export type RecipientType   = 'organizer' | 'attendee' | 'donor' | 'applicant' | 'user' | 'unknown'

export interface TimelineEntry {
  timelineId:        string
  notificationId:    string | null      // best-effort reverse lookup from the logged template
  templateId:        string             // the logged template (templateKey)
  templateVersion:   number
  policyId:          string | null      // = notificationId when resolvable
  recipient:         string
  recipientType:     RecipientType
  channel:           TimelineChannel
  provider:          string
  trigger:           string
  status:            TimelineStatus
  // All timestamps optional (ISO 8601).
  queuedAt?:         string
  acceptedAt?:       string
  sentAt?:           string
  deliveredAt?:      string
  openedAt?:         string
  clickedAt?:        string
  failedAt?:         string
  cancelledAt?:      string
  completedAt?:      string
  retryCount:        number
  latencyMs:         number | null
  providerReference: string | null
  errorCode:         string | null
  errorMessage:      string | null
  metadata:          Record<string, string | number | undefined>
}

/** Read-only query filters exposed by the timeline API. */
export interface TimelineFilters {
  search?:       string
  notification?: string
  provider?:     string
  channel?:      TimelineChannel
  status?:       TimelineStatus
  dateFrom?:     string
  dateTo?:       string
  recipient?:    string
  priority?:     string
  category?:     string
  limit?:        number
}

// ─── Future extension points (Phase 4G+) — RESERVED, NOT IMPLEMENTED ──────────
// The timeline is deliberately a pure historical record. These are the seams later phases
// plug into WITHOUT changing this read model. Declaring them documents the contract; none
// are wired, and the timeline itself performs no replay/retry/analytics.
export interface TimelineExtensionPoints {
  replay?:          never   // Phase: Support Tools — re-dispatch from a timeline entry
  analytics?:       never   // Phase: Analytics — aggregate over timeline entries
  rulesEngine?:     never   // Phase: Rules Engine — trigger on timeline transitions
  campaignInsights?: never  // Phase: Campaign Analytics — per-campaign timeline rollups
  supportTools?:    never   // Phase: Support — investigate a recipient's timeline
}
