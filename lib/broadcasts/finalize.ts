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
import { settleBroadcastBilling }  from '@/lib/communications/billing'
import { transitionCampaign }      from './jobPreparation'

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
  /** RD-COMMS-P2-G — recipients deliberately NOT sent (opted out / suppressed at send time). They
   *  are neither a success nor a failure; 0 (every caller but the email job) changes nothing. */
  skippedCount = 0,
): Promise<void> {
  const uid            = c.organizerUid
  const actorUid       = c.createdBy ?? c.organizerUid
  const recipientCount = recipients.length
  const sendable       = Math.max(0, recipientCount - skippedCount)
  const finalStatus = successCount === sendable ? 'sent' : successCount === 0 ? 'failed' : 'partial'

  // RD-COMMS-P2-B — status-GUARDED: only a `sending` campaign is finalized. A campaign a concurrent
  // cancel (or fail) already ended keeps that state — cancelled → sent can never happen.
  const moved = await transitionCampaign(ref, ['sending'], {
    status: finalStatus, successCount, failCount, sentAt: FieldValue.serverTimestamp(),
    ...(skippedCount > 0 ? { skippedCount } : {}),
  })

  // RD-INTEG · D3 — charge on accept: return the money/prepaid units of every recipient WhatsApp
  // did not accept. `successCount` here IS the accepted count (the WhatsApp caller passes the
  // recipients marked sent). Email broadcasts are free and carry no charge to settle. Settlement is
  // idempotent and runs whichever path ended the campaign.
  let costPaise = c.actualCostPaise ?? 0
  if (c.channel === 'whatsapp') {
    try { costPaise = (await settleBroadcastBilling(campaignId, successCount)).netCostPaise }
    catch (err) { console.error('[broadcast] billing settlement failed — the sweep retries it:', { campaignId, err: err instanceof Error ? err.message : err }) }
  }
  // The completion side effects (inbox, usage, audit, webhook, CRM) belong to the path that
  // actually moved the campaign; a lost race must not report a send as completed.
  if (!moved) return

  // H.4.3: record broadcast completion in the organizer Notification Center inbox.
  void notifyBroadcastComplete({ workspaceUid: uid, broadcastId: campaignId, status: finalStatus, sent: successCount, failed: failCount })

  // ── Usage tracking — reconciles with the ledger (costPaise = charged amount) ──
  // RD-CLOSE — a WhatsApp campaign's usage record is written by its billing settlement, atomically
  // with the money (settleBroadcastBilling). Only free email broadcasts are recorded here.
  if (successCount > 0 && c.channel !== 'whatsapp') {
    // Deterministic id (bc_<campaignId>): one row per campaign, and settlement can correct it.
    void adminDb.collection('communicationUsage').doc(`bc_${campaignId}`).set({
      organizerUid: uid, eventId: c.eventId, eventSlug: c.eventSlug, eventName: c.eventName,
      channel: c.channel, quantity: successCount, costPaise,
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
