// RD-PLATFORM-COMMS-01 Phase 4F — the ONE canonical Communication Timeline resolver.
//
// Reads the existing emailLogs collection (the historical record of every platform email +
// WhatsApp communication), maps each row through the PURE mapper (./map), and applies the
// requested read-only filters. Server-only. READ-ONLY: it queries and shapes — it never
// writes, replays, resends, retries, or mutates. No new storage, no behavior change.

import { adminDb } from '@/lib/firebase/admin'
import type { EmailLog, EmailLogStatus, CommunicationChannel, WhatsAppDeliveryStatus } from '@/lib/email-logs/types'
import { getRegistryEntry } from '@/lib/communications/registry/catalog'
import { emailLogToTimelineEntry } from './map'
import type { TimelineEntry, TimelineFilters } from './types'

export interface TimelineResult {
  entries: TimelineEntry[]
  count:   number
  scanned: number   // rows scanned before filtering (honest — timeline is not exhaustive)
}

function tsToIso(ts: unknown): string {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  if (typeof ts === 'string') return ts
  return new Date(0).toISOString()
}

function docToEmailLog(id: string, d: Record<string, unknown>): EmailLog {
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '')
  return {
    id,
    organizerUid:      s('organizerUid'),
    eventId:           s('eventId'),
    eventSlug:         s('eventSlug'),
    eventName:         s('eventName'),
    templateKey:       s('templateKey'),
    recipientEmail:    s('recipientEmail'),
    recipientName:     s('recipientName'),
    subject:           s('subject'),
    status:            (typeof d.status === 'string' ? d.status : 'queued') as EmailLogStatus,
    provider:          s('provider') || 'ses',
    channel:           (d.channel === 'whatsapp' ? 'whatsapp' : 'email') as CommunicationChannel,
    recipientPhone:    typeof d.recipientPhone === 'string' ? d.recipientPhone : undefined,
    costPaise:         typeof d.costPaise === 'number' ? d.costPaise : undefined,
    providerMessageId: typeof d.providerMessageId === 'string' ? d.providerMessageId : undefined,
    providerResponse:  typeof d.providerResponse === 'string' ? d.providerResponse : undefined,
    error:             typeof d.error === 'string' ? d.error : undefined,
    registrationId:    s('registrationId'),
    campaignId:        typeof d.campaignId === 'string' ? d.campaignId : undefined,
    waStatus:          typeof d.waStatus === 'string' ? (d.waStatus as WhatsAppDeliveryStatus) : undefined,
    deliveredAt:       d.deliveredAt ? tsToIso(d.deliveredAt) : undefined,
    readAt:            d.readAt ? tsToIso(d.readAt) : undefined,
    failedAt:          d.failedAt ? tsToIso(d.failedAt) : undefined,
    statusUpdatedAt:   d.statusUpdatedAt ? tsToIso(d.statusUpdatedAt) : undefined,
    createdAt:         tsToIso(d.createdAt),
    updatedAt:         tsToIso(d.updatedAt),
  }
}

/** Resolve platform communication timeline entries for the given read-only filters. */
export async function resolveTimeline(filters: TimelineFilters = {}): Promise<TimelineResult> {
  const limit = Math.min(Math.max(filters.limit ?? 200, 1), 500)

  let query = adminDb.collection('emailLogs').orderBy('createdAt', 'desc') as FirebaseFirestore.Query
  if (filters.channel) query = query.where('channel', '==', filters.channel)
  if (filters.dateFrom) { const f = new Date(filters.dateFrom); f.setHours(0, 0, 0, 0);    query = query.where('createdAt', '>=', f) }
  if (filters.dateTo)   { const t = new Date(filters.dateTo);   t.setHours(23, 59, 59, 999); query = query.where('createdAt', '<=', t) }

  const snap = await query.limit(limit).get()
  const scanned = snap.size

  let entries = snap.docs.map(doc => emailLogToTimelineEntry(docToEmailLog(doc.id, doc.data() as Record<string, unknown>)))

  // In-memory (read-only) refinement filters.
  const term = filters.search?.trim().toLowerCase()
  entries = entries.filter(e => {
    if (filters.status && e.status !== filters.status) return false
    if (filters.provider && e.provider !== filters.provider) return false
    if (filters.notification && e.notificationId !== filters.notification) return false
    if (filters.recipient && !e.recipient.toLowerCase().includes(filters.recipient.toLowerCase())) return false
    if (filters.category || filters.priority) {
      const reg = e.notificationId ? getRegistryEntry(e.notificationId as never) : undefined
      if (filters.category && reg?.category !== filters.category) return false
      if (filters.priority && reg?.priority !== filters.priority) return false
    }
    if (term) {
      const hay = `${e.recipient} ${e.trigger} ${e.metadata.subject ?? ''} ${e.metadata.eventName ?? ''}`.toLowerCase()
      if (!hay.includes(term)) return false
    }
    return true
  })

  return { entries, count: entries.length, scanned }
}
