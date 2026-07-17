// Types for the admin audit-log viewer. Reuses the audit action/entity unions.

import type { AdminAuditAction, AdminAuditEntityType } from '@/lib/admin/audit'

export interface AuditLogItem {
  id:         string
  adminUid:   string
  action:     AdminAuditAction
  entityType: AdminAuditEntityType
  entityId:   string
  createdAt:  string | null                 // ISO 8601
  metadata:   Record<string, unknown> | null
}

export interface AuditLogFilters {
  action?:     AdminAuditAction
  entityType?: AdminAuditEntityType
  adminUid?:   string
  entityId?:   string
  startDate?:  string   // ISO / parseable date
  endDate?:    string   // ISO / parseable date
  cursor?:     string
  pageSize?:   number
}

export interface AuditLogResponse {
  items:       AuditLogItem[]
  nextCursor?: string | null
}
