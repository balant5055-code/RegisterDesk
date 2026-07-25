// RD-PLATFORM-COMMS-01 Phase 4F — pure emailLog → TimelineEntry mapper (isomorphic).
//
// The ONE place a stored communication log becomes a canonical timeline entry. PURE — input
// a log, output an entry; no I/O, no mutation. Best-effort links to the registry (notification/
// trigger/recipient-type) are derived read-only from the logged templateKey; nothing is
// fabricated (unresolvable links are null/'unknown').

import type { EmailLog } from '@/lib/email-logs/types'
import { COMMUNICATION_REGISTRY } from '@/lib/communications/registry/catalog'
import type { TimelineEntry, TimelineStatus, TimelineChannel, RecipientType } from './types'

// Reverse map: logged templateKey → the first registry entry that uses it (best-effort — a
// key like 'review' is shared by several notifications; the first is a representative link).
const TEMPLATE_KEY_TO_ENTRY = (() => {
  const m: Record<string, (typeof COMMUNICATION_REGISTRY)[number]> = {}
  for (const e of COMMUNICATION_REGISTRY) if (!(e.templateKey in m)) m[e.templateKey] = e
  return m
})()

const AUDIENCE_TO_RECIPIENT: Record<string, RecipientType> = {
  organizer: 'organizer', attendee: 'attendee', donor: 'donor', applicant: 'applicant', user: 'user',
}

function mapStatus(log: EmailLog): TimelineStatus {
  if (log.waStatus === 'read') return 'opened'      // WhatsApp read ≈ engagement/opened
  switch (log.status) {
    case 'queued':    return 'queued'
    case 'sent':      return 'sent'
    case 'delivered': return 'delivered'
    case 'failed':    return 'failed'
    case 'skipped':   return 'cancelled'             // not sent (e.g. insufficient balance)
    default:          return 'unknown'
  }
}

function diffMs(from?: string, to?: string): number | null {
  if (!from || !to) return null
  const a = Date.parse(from), b = Date.parse(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  const d = b - a
  return d >= 0 ? d : null
}

/** Parse a compact provider-response string for a leading error code (e.g. "HTTP 400 · code 132000"). */
function parseErrorCode(resp?: string): string | null {
  if (!resp) return null
  const m = resp.match(/code\s+(\w+)/i) ?? resp.match(/HTTP\s+(\d{3})/i)
  return m ? m[1] : null
}

/** Map a stored emailLog to a canonical timeline entry. PURE. */
export function emailLogToTimelineEntry(log: EmailLog): TimelineEntry {
  const channel: TimelineChannel = (log.channel ?? 'email')
  const entry   = TEMPLATE_KEY_TO_ENTRY[log.templateKey]
  const status  = mapStatus(log)

  const sentAt      = log.status === 'sent' || log.status === 'delivered' ? log.createdAt : undefined
  const deliveredAt = log.deliveredAt
  const openedAt    = log.waStatus === 'read' ? log.readAt : undefined
  const failedAt    = log.failedAt ?? (log.status === 'failed' ? (log.statusUpdatedAt ?? log.updatedAt) : undefined)
  const cancelledAt = log.status === 'skipped' ? log.createdAt : undefined
  const completedAt = deliveredAt ?? failedAt ?? cancelledAt ?? sentAt

  return {
    timelineId:        log.id,
    notificationId:    entry?.id ?? null,
    templateId:        log.templateKey,
    templateVersion:   1,
    policyId:          entry?.id ?? null,
    recipient:         log.recipientEmail || log.recipientPhone || log.recipientName || '—',
    recipientType:     entry ? (AUDIENCE_TO_RECIPIENT[entry.audience] ?? 'unknown') : 'unknown',
    channel,
    provider:          log.provider,
    trigger:           entry?.trigger ?? log.templateKey,
    status,
    queuedAt:          log.createdAt,
    sentAt,
    deliveredAt,
    openedAt,
    failedAt,
    cancelledAt,
    completedAt,
    retryCount:        0,                            // emailLogs do not track per-message retries today
    latencyMs:         diffMs(log.createdAt, completedAt),
    providerReference: log.providerMessageId ?? null,
    errorCode:         parseErrorCode(log.providerResponse) ?? null,
    errorMessage:      log.error ?? null,
    metadata: {
      eventId:    log.eventId || undefined,
      eventName:  log.eventName || undefined,
      eventSlug:  log.eventSlug || undefined,
      subject:    log.subject || undefined,
      campaignId: log.campaignId || undefined,
      costPaise:  log.costPaise,
      waStatus:   log.waStatus || undefined,
    },
  }
}
