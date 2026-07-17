// Read service for the admin audit-log viewer. Server-only (Admin SDK).
//
// Cursor-paginated, createdAt-desc. One equality filter is applied at the query
// level (priority: entityId > adminUid > action > entityType) alongside the
// createdAt range, using the composite indexes (field, createdAt). Any remaining
// equality filters are applied in memory per page (mirrors the moderation/report
// queues) so the index surface stays bounded. Never scans the whole collection.

import { Timestamp }      from 'firebase-admin/firestore'
import { adminDb }        from '@/lib/firebase/admin'
import type { AdminAuditAction, AdminAuditEntityType } from '@/lib/admin/audit'
import type { AuditLogFilters, AuditLogItem, AuditLogResponse } from '@/lib/admin/auditViewerTypes'

const DEFAULT_PAGE = 50
const MAX_PAGE     = 200

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function toItem(id: string, data: Record<string, unknown>): AuditLogItem {
  return {
    id,
    adminUid:   typeof data.adminUid === 'string' ? data.adminUid : '',
    action:     data.action as AdminAuditAction,
    entityType: data.entityType as AdminAuditEntityType,
    entityId:   typeof data.entityId === 'string' ? data.entityId : '',
    createdAt:  tsToISO(data.createdAt),
    metadata:   (data.metadata && typeof data.metadata === 'object')
      ? data.metadata as Record<string, unknown>
      : null,
  }
}

function parseDate(value: string | undefined): Timestamp | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : Timestamp.fromDate(d)
}

export async function listAuditLogs(filters: AuditLogFilters): Promise<AuditLogResponse> {
  const pageSize = Math.min(MAX_PAGE, Math.max(1, filters.pageSize ?? DEFAULT_PAGE))
  const col      = adminDb.collection('adminAuditLogs')

  let query: FirebaseFirestore.Query = col

  // One equality filter at the query level (most selective first).
  let primary: 'entityId' | 'adminUid' | 'action' | 'entityType' | null = null
  if (filters.entityId)        { query = query.where('entityId', '==', filters.entityId);     primary = 'entityId' }
  else if (filters.adminUid)   { query = query.where('adminUid', '==', filters.adminUid);     primary = 'adminUid' }
  else if (filters.action)     { query = query.where('action', '==', filters.action);         primary = 'action' }
  else if (filters.entityType) { query = query.where('entityType', '==', filters.entityType); primary = 'entityType' }

  const startTs = parseDate(filters.startDate)
  const endTs   = parseDate(filters.endDate)
  if (startTs) query = query.where('createdAt', '>=', startTs)
  if (endTs)   query = query.where('createdAt', '<=', endTs)

  query = query.orderBy('createdAt', 'desc').limit(pageSize + 1)

  if (filters.cursor) {
    const curSnap = await col.doc(filters.cursor).get()
    if (curSnap.exists) query = query.startAfter(curSnap)
  }

  const snap     = await query.get()
  const hasMore  = snap.docs.length > pageSize
  const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs

  let items = pageDocs.map(d => toItem(d.id, d.data() as Record<string, unknown>))

  // Remaining equality filters (not used as the query primary) — in memory.
  if (primary !== 'action'     && filters.action)     items = items.filter(i => i.action === filters.action)
  if (primary !== 'entityType' && filters.entityType) items = items.filter(i => i.entityType === filters.entityType)
  if (primary !== 'adminUid'   && filters.adminUid)   items = items.filter(i => i.adminUid === filters.adminUid)
  if (primary !== 'entityId'   && filters.entityId)   items = items.filter(i => i.entityId === filters.entityId)

  // Cursor advances over the raw scan (last page doc), independent of in-memory
  // filtering — the client pages until nextCursor is null.
  const nextCursor = hasMore ? pageDocs[pageDocs.length - 1].id : null
  return { items, nextCursor }
}

export async function getAuditLog(id: string): Promise<AuditLogItem | null> {
  const snap = await adminDb.doc(`adminAuditLogs/${id}`).get()
  if (!snap.exists) return null
  return toItem(snap.id, snap.data() as Record<string, unknown>)
}
