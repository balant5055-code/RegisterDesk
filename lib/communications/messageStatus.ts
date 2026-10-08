// RD-COMMS-P2-F — how ONE message's outcome is shown to an organizer. Client-safe, pure.
//
// RD-COMMS-P2-D keeps `status: 'failed'` on a log whose outcome the provider never confirmed (a
// timeout, a dropped connection, a 5xx, an interrupted send) and adds `deliveryUnknown: true`.
// Such a message MAY have been delivered: it is shown as "Delivery unknown" — never as Sent, never
// as Failed — and nothing offers to resend it (the retry route refuses it; a resend could be a
// duplicate).

export type CommDisplayStatus = 'sent' | 'delivered' | 'failed' | 'unknown' | 'skipped' | 'queued'

export const COMM_STATUS_LABELS: Record<CommDisplayStatus, string> = {
  sent:      'Sent',
  delivered: 'Delivered',
  failed:    'Failed',
  unknown:   'Delivery unknown',
  skipped:   'Skipped',
  queued:    'Queued',
}

export const DELIVERY_UNKNOWN_HELP =
  'The email or message provider gave no definite answer, so it may or may not have been delivered. ' +
  'To avoid sending a duplicate, it is not retried and cannot be resent from here.'

/** The status to SHOW for a log row. */
export function commStatusOf(row: { status: string; deliveryUnknown?: boolean | null }): CommDisplayStatus {
  if (row.deliveryUnknown === true && row.status !== 'sent' && row.status !== 'delivered') return 'unknown'
  switch (row.status) {
    case 'sent': case 'delivered': case 'failed': case 'skipped': case 'queued': return row.status
    default: return 'queued'
  }
}

/** Whether the manual "Retry" may be offered: a DEFINITE failure only (mirrors the retry route). */
export function canOfferRetry(row: { status: string; deliveryUnknown?: boolean | null }): boolean {
  return commStatusOf(row) === 'failed'
}

/**
 * What a message cost, honestly: email is included; a WhatsApp message is drawn from the event's
 * purchased capacity (counted on Usage, not per message) — only the LEGACY balance ever charged
 * per message, so that is the only amount shown. Never "Free" for WhatsApp.
 */
export function chargeLabel(row: { channel: string; costPaise: number }, inr: (paise: number) => string): string {
  if (row.channel !== 'whatsapp') return 'Included'
  return row.costPaise > 0 ? `${inr(row.costPaise)} · legacy balance` : '—'
}
