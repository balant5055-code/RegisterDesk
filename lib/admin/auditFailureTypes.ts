// lib/admin/auditFailureTypes.ts
// RD-PHASE4-S4 closeout — client-safe types for the Super Admin review of `adminAuditFailures`
// (audit rows that could not be written AFTER an external action already happened; see
// logAdminActionOrRecord in lib/admin/audit.ts). No firebase-admin import.

export type AuditFailureStatus = 'open' | 'resolved'
export const AUDIT_FAILURE_STATUS_FILTERS = ['open', 'resolved', 'all'] as const
export type AuditFailureStatusFilter = typeof AUDIT_FAILURE_STATUS_FILTERS[number]

/**
 * How an open failure was reconciled:
 *   replayed        — the missing audit row was re-created from the stored copy (deterministic id);
 *   already_present — the server found the original audit row after all (the write had landed).
 */
export type AuditFailureResolution = 'replayed' | 'already_present'
export const AUDIT_FAILURE_ACTIONS = ['replay', 'mark_present'] as const
export type AuditFailureAction = typeof AUDIT_FAILURE_ACTIONS[number]

export interface AuditFailureItem {
  id:          string
  status:      AuditFailureStatus
  createdAt:   string | null
  /** The write error, secrets redacted and length-capped. */
  error:       string
  /** The audit row that failed to be written (already sanitized when it was recorded). */
  audit: {
    action:      string
    entityType:  string
    entityId:    string
    adminUid:    string
    actorRole:   string | null
    reason:      string | null
    at:          string | null
    correlation: Record<string, unknown> | null
    metadata:    Record<string, unknown> | null
  }
  resolution: null | {
    kind:             AuditFailureResolution
    by:               string
    at:               string | null
    reason:           string
    recoveredAuditId: string | null
  }
}

export interface AuditFailureListResponse {
  items:      AuditFailureItem[]
  nextCursor: string | null
  /** Documents examined for this page (the status filter is applied in memory — no new index). */
  scanned:    number
}

export interface AuditFailureDetailResponse {
  item: AuditFailureItem
  /** Rows already in adminAuditLogs for the same entity + action near the failure time. */
  existingMatches: Array<{ id: string; at: string | null; adminUid: string }>
}

export interface AuditFailureActionResponse {
  id:               string
  status:           'resolved'
  resolution:       AuditFailureResolution
  recoveredAuditId: string | null
}
