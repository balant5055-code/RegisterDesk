// THE single broadcast send path — used by both the create route (send-now) and
// the scheduler cron. Never duplicate this logic elsewhere.
//
//   startBroadcastCampaign()   — atomic bill + transition (scheduled/draft → sending),
//                                then deliver. Replay-safe via chargeAndStartCampaign.
//   deliverBroadcastCampaign() — the actual send loop; only runs a campaign that is
//                                in 'sending' (idempotent guard), then writes the
//                                final status, usage and audit.

import { FieldValue }              from 'firebase-admin/firestore'
import { adminDb }                 from '@/lib/firebase/admin'
import { notificationEngine, NotificationChannel } from '@/lib/notifications'
import { getOrganiserSuppressionSet } from '@/lib/firebase/firestore/emailSuppressionList'
import { chargeAndStartCampaign, type StartResult } from '@/lib/communications/billing'
import { logBroadcastAction }      from '@/lib/broadcasts/audit'
import { getMetaProvider, hasWhatsAppTemplate } from '@/lib/whatsapp'
import { createWhatsAppBroadcastJob, processWhatsAppBroadcastChunk } from './whatsappJob'
import { createEmailBroadcastJob, processEmailBroadcastChunk } from './emailJob'
import type { BroadcastChannel }   from '@/lib/broadcasts/types'
import type { RegistrationDocument } from '@/lib/registrations/types'

type Recipient = { id: string; data: RegistrationDocument }

interface CampaignData {
  organizerUid: string
  createdBy?:   string
  eventId:      string
  eventSlug:    string
  eventName:    string
  channel:      BroadcastChannel
  audience:     string
  subject:      string
  html:         string
  status:       string
  recipientCount: number
  actualCostPaise: number
  // WhatsApp channel (WA-1): approved Meta template + language + static variables.
  templateType?: string
  languageCode?: string
  variables?:    Record<string, string>
  // WA-3 / OE-2: the generic-runner job that executes this campaign (once created).
  whatsappJobId?: string
  emailJobId?:    string
}

// ─── Bill + start (the only entry point for kicking off a campaign) ───────────

export async function startBroadcastCampaign(args: {
  campaignId:   string
  organizerUid: string
  actorUid:     string
  channel:      BroadcastChannel
  recipientCount: number
}): Promise<StartResult> {
  const result = await chargeAndStartCampaign({
    campaignId:     args.campaignId,
    organizerUid:   args.organizerUid,
    channel:        args.channel,
    recipientCount: args.recipientCount,
  })

  if (!result.ok) {
    if (result.reason === 'insufficient_balance') {
      void logBroadcastAction({
        organizerUid: args.organizerUid, actorUid: args.actorUid,
        action: 'broadcast.failed', campaignId: args.campaignId, metadata: { reason: 'insufficient_balance' },
      }).catch(() => { /* best-effort */ })
    }
    return result   // bad_state ⇒ replay, no-op
  }

  await deliverBroadcastCampaign(args.campaignId)
  return result
}

// ─── Deliver (idempotent: only a 'sending' campaign is delivered) ─────────────

export async function deliverBroadcastCampaign(campaignId: string): Promise<void> {
  const ref  = adminDb.collection('broadcastCampaigns').doc(campaignId)
  const snap = await ref.get()
  if (!snap.exists) return
  const c = snap.data() as CampaignData
  if (c.status !== 'sending') return   // guard — never deliver twice

  const uid      = c.organizerUid
  const actorUid = c.createdBy ?? c.organizerUid

  // Both channels are executed on the generic job runner (WA-3 / OE-2).
  if (c.channel === 'whatsapp') { await deliverWhatsAppCampaign(ref, campaignId, c, uid, actorUid); return }
  await deliverEmailCampaign(ref, campaignId, c, uid, actorUid)
}

// ─── Email delivery (OE-2) — executed on the generic job runner ───────────────
// The per-recipient render + SES send loop lives in the EmailBroadcastStrategy
// (emailJob). Here we only snapshot recipients + create the job once (idempotent
// via emailJobId), then drive the FIRST chunk; the email-broadcasts cron finishes
// the rest with lease/cursor/commit/cancel/resume. Completion → finalizeBroadcast.

async function deliverEmailCampaign(
  ref: FirebaseFirestore.DocumentReference,
  campaignId: string,
  c: CampaignData,
  uid: string,
  actorUid: string,
): Promise<void> {
  if (c.emailJobId) { await processEmailBroadcastChunk(c.emailJobId); return }

  // Same audience query as before; drop addresses on the organizer's suppression list.
  let regsQuery = adminDb.collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', c.eventSlug) as FirebaseFirestore.Query
  if (c.audience !== 'all') regsQuery = regsQuery.where('status', '==', c.audience)
  const regsSnap    = await regsQuery.get()
  const suppression = await getOrganiserSuppressionSet(uid)
  const recipients: Recipient[] = regsSnap.docs
    .map(d => ({ id: d.id, data: d.data() as RegistrationDocument }))
    .filter(({ data }) => !suppression.has(data.attendee.email.toLowerCase().trim()))

  const emailAvailable = notificationEngine.isAvailable(NotificationChannel.EMAIL)

  // No provider / no recipients — resolve immediately (no job).
  if (!emailAvailable || recipients.length === 0) {
    const finalStatus = recipients.length === 0 ? 'sent' : 'failed'
    await ref.update({
      status: finalStatus, successCount: 0, failCount: recipients.length,
      sentAt: FieldValue.serverTimestamp(), ...(emailAvailable ? {} : { failReason: 'provider_unavailable' }),
    })
    void logBroadcastAction({
      organizerUid: uid, actorUid, campaignId,
      action: finalStatus === 'sent' ? 'broadcast.sent' : 'broadcast.failed',
      metadata: { recipientCount: recipients.length, reason: emailAvailable ? undefined : 'provider_unavailable' },
    }).catch(() => {})
    return
  }

  const job = await createEmailBroadcastJob(campaignId, c, recipients)
  await ref.update({ emailJobId: job.jobId })
  await processEmailBroadcastChunk(job.jobId)
}

// ─── WhatsApp delivery (WA-3) — executed on the generic job runner ────────────
// The per-recipient send loop lives in the WhatsAppBroadcastStrategy (whatsappJob).
// Here we only snapshot recipients + create the job once (idempotent via
// whatsappJobId), then drive the FIRST chunk; the whatsapp-broadcasts cron finishes
// the rest with lease/cursor/commit/cancel/resume. Completion → finalizeBroadcast.

async function deliverWhatsAppCampaign(
  ref: FirebaseFirestore.DocumentReference,
  campaignId: string,
  c: CampaignData,
  uid: string,
  actorUid: string,
): Promise<void> {
  let jobId = c.whatsappJobId

  if (!jobId) {
    // Recipients: same audience query; require a phone. Email suppression is an
    // email-channel concept and does not apply to WhatsApp (opt-out is WA-2/WA-5).
    let regsQuery = adminDb.collection('registrations')
      .where('organizerUid', '==', uid)
      .where('eventSlug',    '==', c.eventSlug) as FirebaseFirestore.Query
    if (c.audience !== 'all') regsQuery = regsQuery.where('status', '==', c.audience)
    const regsSnap = await regsQuery.get()
    const recipients: Recipient[] = regsSnap.docs
      .map(d => ({ id: d.id, data: d.data() as RegistrationDocument }))
      .filter(({ data }) => typeof data.attendee.phone === 'string' && data.attendee.phone.trim().length > 0)

    const provider      = await getMetaProvider()
    const validTemplate = typeof c.templateType === 'string' && hasWhatsAppTemplate(c.templateType)

    // No provider / no template / no recipients — resolve immediately (no job).
    if (!provider || !validTemplate || recipients.length === 0) {
      const finalStatus = recipients.length === 0 ? 'sent' : 'failed'
      const failReason  = !provider ? 'provider_unavailable' : !validTemplate ? 'invalid_template' : undefined
      await ref.update({
        status: finalStatus, successCount: 0, failCount: recipients.length,
        sentAt: FieldValue.serverTimestamp(), ...(failReason ? { failReason } : {}),
      })
      void logBroadcastAction({
        organizerUid: uid, actorUid, campaignId,
        action: finalStatus === 'sent' ? 'broadcast.sent' : 'broadcast.failed',
        metadata: { recipientCount: recipients.length, reason: failReason },
      }).catch(() => {})
      return
    }

    const job = await createWhatsAppBroadcastJob(campaignId, c, recipients)
    jobId = job.jobId
    await ref.update({ whatsappJobId: jobId })
  }

  // Drive the first chunk now; the cron completes the rest (resumable/cancellable).
  await processWhatsAppBroadcastChunk(jobId)
}
