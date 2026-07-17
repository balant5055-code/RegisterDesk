// Applies a WhatsApp delivery-status event to the matching emailLogs row(s) (WA-2).
// Server-only. Because BOTH broadcast and transactional WhatsApp write to emailLogs
// with providerMessageId = wamid, this ONE function updates both — no duplicate code.
//
// Idempotent + order-safe: WhatsApp status callbacks can arrive out of order and
// more than once. A per-doc transaction only ADVANCES the state (sent → delivered
// → read); a stale/duplicate event is a no-op. `failed` is applied only while the
// message has not yet been delivered (a delivered/read message never "fails").

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { WhatsAppDeliveryStatus } from './types'
import type { WhatsAppStatusEvent } from '@/lib/whatsapp/webhookStatus'

const COLLECTION = 'emailLogs'

// Monotonic rank — only apply an event whose rank exceeds the stored one.
// `failed` shares 'sent's rank (2 > 1) so it can supersede a bare 'sent' but never
// an already-delivered (3) / read (4) message.
const RANK: Record<WhatsAppDeliveryStatus, number> = { sent: 1, failed: 2, delivered: 3, read: 4 }

// The coarse EmailLogStatus mirror (no 'read' — a read stays 'delivered').
const TO_LOG_STATUS: Record<WhatsAppDeliveryStatus, 'sent' | 'delivered' | 'failed'> = {
  sent: 'sent', delivered: 'delivered', read: 'delivered', failed: 'failed',
}

/**
 * Applies one status event to every emailLogs row carrying its wamid. Returns the
 * number of rows updated (0 when the wamid is unknown or the event is stale).
 */
export async function applyWhatsAppDeliveryStatus(event: WhatsAppStatusEvent): Promise<number> {
  const snap = await adminDb.collection(COLLECTION)
    .where('providerMessageId', '==', event.wamid)
    .limit(10)
    .get()
  if (snap.empty) return 0

  let updated = 0
  for (const doc of snap.docs) {
    const applied = await adminDb.runTransaction(async txn => {
      const cur = await txn.get(doc.ref)
      if (!cur.exists) return false
      const data = cur.data() as { waStatus?: WhatsAppDeliveryStatus; deliveredAt?: unknown }

      const curRank = data.waStatus ? RANK[data.waStatus] : 0
      if (RANK[event.status] <= curRank) return false   // stale / duplicate → no-op

      const ts = event.timestampMs > 0 ? Timestamp.fromMillis(event.timestampMs) : FieldValue.serverTimestamp()
      const patch: Record<string, unknown> = {
        waStatus:        event.status,
        status:          TO_LOG_STATUS[event.status],
        statusUpdatedAt: ts,
        updatedAt:       FieldValue.serverTimestamp(),
      }
      if (event.status === 'delivered') patch.deliveredAt = ts
      if (event.status === 'read') {
        patch.readAt = ts
        if (!data.deliveredAt) patch.deliveredAt = ts   // read implies delivered
      }
      if (event.status === 'failed') {
        patch.failedAt = ts
        if (event.error) patch.error = event.error
      }
      if (event.providerResponse) patch.providerResponse = event.providerResponse

      txn.update(doc.ref, patch)
      return true
    })
    if (applied) updated++
  }
  return updated
}
