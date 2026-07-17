// Shared campaign completion (channel-agnostic) — extracted from send.ts so BOTH
// the inline email delivery loop AND the WhatsApp job strategy (WA-3) can reuse it
// without a circular import. Writes the final status + inbox + usage + audit +
// webhook + CRM exactly once.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { logBroadcastAction }      from '@/lib/broadcasts/audit'
import { enqueueWebhook }          from '@/lib/integrations/webhooks'
import { crmRecordBroadcastBatch } from '@/lib/crm/service'
import { notifyBroadcastComplete } from '@/lib/notifications/inbox/notify'
import type { BroadcastChannel }   from '@/lib/broadcasts/types'

// Only the campaign fields finalize needs (send.ts CampaignData is a superset).
export interface FinalizeCampaign {
  organizerUid:    string
  createdBy?:      string
  eventId:         string
  eventSlug:       string
  eventName:       string
  channel:         BroadcastChannel
  actualCostPaise: number
}

// Minimal recipient shape for the CRM batch (a full RegistrationDocument is assignable).
export type FinalizeRecipient = { id: string; data: { attendee: { email: string; name: string } } }

export async function finalizeBroadcast(
  ref: FirebaseFirestore.DocumentReference,
  campaignId: string,
  c: FinalizeCampaign,
  successCount: number,
  failCount: number,
  recipients: FinalizeRecipient[],
): Promise<void> {
  const uid            = c.organizerUid
  const actorUid       = c.createdBy ?? c.organizerUid
  const recipientCount = recipients.length
  const finalStatus = successCount === recipientCount ? 'sent' : successCount === 0 ? 'failed' : 'partial'

  await ref.update({ status: finalStatus, successCount, failCount, sentAt: FieldValue.serverTimestamp() })

  // H.4.3: record broadcast completion in the organizer Notification Center inbox.
  void notifyBroadcastComplete({ workspaceUid: uid, broadcastId: campaignId, status: finalStatus, sent: successCount, failed: failCount })

  // ── Usage tracking — reconciles with the ledger (costPaise = charged amount) ──
  if (successCount > 0) {
    void adminDb.collection('communicationUsage').add({
      organizerUid: uid, eventId: c.eventId, eventSlug: c.eventSlug, eventName: c.eventName,
      channel: c.channel, quantity: successCount, costPaise: c.actualCostPaise ?? 0,
      campaignId, templateKey: 'broadcast', createdAt: FieldValue.serverTimestamp(),
    }).catch(() => {})
  }

  void logBroadcastAction({
    organizerUid: uid, actorUid,
    action: finalStatus === 'failed' ? 'broadcast.failed' : 'broadcast.sent',
    campaignId, metadata: { successCount, failCount, recipientCount },
  }).catch(() => {})

  // Organizer webhook (fire-and-forget) — emitted when anything was delivered.
  if (finalStatus !== 'failed') {
    void enqueueWebhook(uid, 'broadcast.sent', { campaignId, recipientCount, successCount, failCount }).catch(() => {})

    // CRM broadcast_sent activities — post-send batch. Idempotent per (contact, campaign).
    crmRecordBroadcastBatch({
      organizerUid: uid, campaignId, eventSlug: c.eventSlug, eventName: c.eventName,
      recipients: recipients.map(({ data }) => ({ email: data.attendee.email, name: data.attendee.name })),
    })
  }
}
