// THE single broadcast send path — used by both the create route (send-now) and
// the scheduler cron. Never duplicate this logic elsewhere.
//
//   startBroadcastCampaign()   — atomic bill + transition (scheduled/draft → sending),
//                                then deliver. Replay-safe via chargeAndStartCampaign.
//   deliverBroadcastCampaign() — the actual send loop; only runs a campaign that is
//                                in 'sending' (idempotent guard), then writes the
//                                final status, usage and audit.

import { applyAudienceRefundRule } from '@/lib/broadcasts/audienceRefunds'
import { filterWhatsAppBroadcastRecipients } from '@/lib/whatsapp/broadcastConsent'
import { FieldValue }              from 'firebase-admin/firestore'
import { adminDb }                 from '@/lib/firebase/admin'
import { notificationEngine, NotificationChannel } from '@/lib/notifications'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { getOrganiserSuppressionSet } from '@/lib/firebase/firestore/emailSuppressionList'
import { resolveMaxRecipientsPerBroadcast } from '@/lib/broadcasts/limits'
import { chargeAndStartCampaign, settleBroadcastBilling, type StartResult } from '@/lib/communications/billing'
import { logBroadcastAction }      from '@/lib/broadcasts/audit'
import { getMetaProvider, hasWhatsAppTemplate } from '@/lib/whatsapp'
import { createWhatsAppBroadcastJob, processWhatsAppBroadcastChunk, WHATSAPP_BROADCAST_JOBS } from './whatsappJob'
import { createEmailBroadcastJob, processEmailBroadcastChunk, EMAIL_BROADCAST_JOBS } from './emailJob'
import { dedupeRecipientsByEmail, dedupeRecipientsByPhone } from './dedupeRecipients'
import { applyRegistrationDateRange, persistedDateBounds } from '@/lib/broadcasts/registrationDateFilter'
import type { BroadcastChannel }   from '@/lib/broadcasts/types'
import type { RegistrationDocument } from '@/lib/registrations/types'
import { broadcastExecutionBlock, type BroadcastBlockReason } from './executionGuard'
import { claimBroadcastJob, transitionCampaign } from './jobPreparation'

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
  /**
   * EMAIL ONLY — "Ignore duplicate email IDs" (see BroadcastCampaign.dedupeEmails).
   * Read off the stored campaign so a SCHEDULED send, which the cron resolves later with
   * nothing but this document, behaves identically to an immediate one.
   * Absent/false ⇒ original behaviour. `deliverWhatsAppCampaign` never reads it.
   */
  dedupeEmails?:  boolean
  /**
   * RD-BCAST-DATE-01 — the registration-date window, as ABSOLUTE Firestore Timestamps
   * resolved when the campaign was CREATED. Absent ⇒ no date constraint, which is every
   * campaign that predates the feature and every 'All registrations' campaign.
   *
   * Read here and nowhere else in the send path. Nothing in this file may consult a clock
   * or a timezone: 'today' was decided at creation, and re-deciding it now would mail a
   * different audience than the one previewed and billed.
   */
  registeredFrom?: unknown
  /** EXCLUSIVE upper bound. See registeredFrom. */
  registeredTo?:   unknown
  /** WHATSAPP ONLY — 'Ignore duplicate WhatsApp numbers'. See BroadcastCampaign.dedupePhones. */
  dedupePhones?:  boolean
  /** RD-INTEG — units paid for upfront (chargeAndStartCampaign); absent on unbilled/legacy campaigns. */
  chargedUnits?:  number
}

// ─── Bill + start (the only entry point for kicking off a campaign) ───────────

/** RD-COMMS-P2-B — start outcomes: the billing results, plus a campaign the execution gate refused. */
export type StartBroadcastResult = StartResult | { ok: false; reason: 'blocked'; block: BroadcastBlockReason }

export async function startBroadcastCampaign(args: {
  campaignId:   string
  organizerUid: string
  actorUid:     string
  channel:      BroadcastChannel
  recipientCount: number
}): Promise<StartBroadcastResult> {
  // RD-COMMS-P2-B — re-check the authoritative state at the moment the campaign actually starts
  // (a scheduled one may start long after it was created), BEFORE anything is charged. A blocked
  // campaign is terminal — failed with its reason — and nothing was charged, so nothing to return.
  const ref = adminDb.collection('broadcastCampaigns').doc(args.campaignId)
  const pre = await ref.get()
  if (!pre.exists) return { ok: false, reason: 'bad_state' }
  const block = await broadcastExecutionBlock({
    organizerUid: args.organizerUid, eventSlug: String((pre.data() as { eventSlug?: unknown }).eventSlug ?? ''), channel: args.channel,
  })
  if (block) {
    const failed = await adminDb.runTransaction(async txn => {
      const s = await txn.get(ref)
      const st = (s.data() as { status?: unknown } | undefined)?.status
      if (st !== 'scheduled' && st !== 'draft') return false     // started / ended meanwhile — not ours to touch
      txn.update(ref, { status: 'failed', failReason: block, actualCostPaise: 0, sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
      return true
    })
    if (!failed) return { ok: false, reason: 'bad_state' }
    void logBroadcastAction({
      organizerUid: args.organizerUid, actorUid: args.actorUid,
      action: 'broadcast.failed', campaignId: args.campaignId, metadata: { reason: block },
    }).catch(() => { /* best-effort */ })
    return { ok: false, reason: 'blocked', block }
  }

  const result = await chargeAndStartCampaign({
    campaignId:     args.campaignId,
    organizerUid:   args.organizerUid,
    channel:        args.channel,
    recipientCount: args.recipientCount,
  })

  if (!result.ok) {
    if (result.reason === 'insufficient_balance' || result.reason === 'allowance_exhausted' || result.reason === 'allowance_required' || result.reason === 'no_recipients') {
      void logBroadcastAction({
        organizerUid: args.organizerUid, actorUid: args.actorUid,
        action: 'broadcast.failed', campaignId: args.campaignId, metadata: { reason: result.reason },
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
  // RD-COMMS-P2-B — one job per campaign: an existing job is driven; otherwise the right to BUILD it
  // is claimed atomically (lib/broadcasts/jobPreparation.ts) so two drivers never build two.
  if (c.emailJobId && await jobExists(EMAIL_BROADCAST_JOBS, c.emailJobId)) { await processEmailBroadcastChunk(c.emailJobId); return }
  const claim = await claimBroadcastJob(ref, 'email', EMAIL_BROADCAST_JOBS)
  if (claim.kind === 'busy' || claim.kind === 'not_sending') return
  if (claim.kind === 'adopt') { await processEmailBroadcastChunk(claim.jobId); return }

  // Same audience query as before; drop addresses on the organizer's suppression list.
  // RD-ORGANIZER-04 P1-1: the campaign already passed the create-time cap gate, so bound
  // the snapshot load to cap+1 — never the whole collection into memory.
  let regsQuery = adminDb.collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', c.eventSlug) as FirebaseFirestore.Query
  if (c.audience !== 'all') regsQuery = regsQuery.where('status', '==', c.audience)
  // RD-BCAST-DATE-01 — the persisted window, applied as a Firestore `where` BEFORE the
  // limit below. After the limit it would be a silent-miss bug: this query has no
  // orderBy, so limit() truncates in document-ID order and an in-memory date filter
  // would then see an arbitrary slice of a large event.
  regsQuery = applyRegistrationDateRange(regsQuery, persistedDateBounds(c.registeredFrom, c.registeredTo))
  const maxRecipients = await resolveMaxRecipientsPerBroadcast(uid)
  const regsSnap    = await regsQuery.limit(maxRecipients + 1).get()
  const suppression = await getOrganiserSuppressionSet(uid)
  // RD-COMMS-CAPACITY-UX (L3) — a 'confirmed' audience never includes a completed refund.
  const suppressed: Recipient[] = applyAudienceRefundRule(c.audience, regsSnap.docs
    .map(d => ({ id: d.id, data: d.data() as RegistrationDocument })))
    .filter(({ data }) => !suppression.has(data.attendee.email.toLowerCase().trim()))

  // "Ignore duplicate email IDs" — applied HERE, before createEmailBroadcastJob, so the
  // snapshot itself holds one row per address. That placement is what makes the guarantee
  // hold for free: the job is created once (emailJobId above short-circuits every resume),
  // and each snapshot row carries its own `sent` flag, so a retry can neither re-resolve the
  // audience nor mail a collapsed duplicate a second time.
  //
  // Read from the CAMPAIGN document, not from a parameter: a scheduled campaign reaches this
  // function from the cron with nothing but the stored campaign, so the flag has to live there.
  const recipients: Recipient[] = c.dedupeEmails
    ? dedupeRecipientsByEmail(suppressed)
    : suppressed

  // RD-EMAIL-PROVIDER — the preflight must ask about the transport the JOB will use,
  // otherwise a campaign could be marked provider_unavailable while its own provider is fine.
  const emailAvailable = notificationEngine.isAvailable(
    NotificationChannel.EMAIL, await resolveEventEmailProvider(c.eventSlug),
  )

  // No provider / no recipients — resolve immediately (no job).
  if (!emailAvailable || recipients.length === 0) {
    const finalStatus = recipients.length === 0 ? 'sent' : 'failed'
    // RD-COMMS-P2-B — status-guarded: a campaign cancelled meanwhile stays cancelled.
    const moved = await transitionCampaign(ref, ['sending'], {
      status: finalStatus, successCount: 0, failCount: recipients.length,
      sentAt: FieldValue.serverTimestamp(), ...(emailAvailable ? {} : { failReason: 'provider_unavailable' }),
      emailJobId: FieldValue.delete(), jobPreparingAt: FieldValue.delete(),
    })
    if (moved) void logBroadcastAction({
      organizerUid: uid, actorUid, campaignId,
      action: finalStatus === 'sent' ? 'broadcast.sent' : 'broadcast.failed',
      metadata: { recipientCount: recipients.length, reason: emailAvailable ? undefined : 'provider_unavailable' },
    }).catch(() => {})
    return
  }

  // Recipients first, job document last, only while the campaign is still sending.
  const job = await createEmailBroadcastJob(campaignId, c, recipients, { jobId: claim.jobId, campaignRef: ref })
  if (!job) return                                   // cancelled while it was being built
  await processEmailBroadcastChunk(job.jobId)
}

const jobExists = async (collection: string, jobId: string) => (await adminDb.collection(collection).doc(jobId).get()).exists

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

  // RD-INTEG — a crash between creating the job and linking it (below) left an orphan job the
  // cron still drives, and a re-delivery would have snapshotted a SECOND job for the same
  // campaign (every recipient messaged twice). Adopt the existing job instead.
  if (!jobId) {
    const orphan = await adminDb.collection(WHATSAPP_BROADCAST_JOBS).where('campaignId', '==', campaignId).limit(1).get()
    if (!orphan.empty && (orphan.docs[0].data() as { campaignId?: unknown }).campaignId === campaignId) {
      jobId = orphan.docs[0].id
      await ref.update({ whatsappJobId: jobId })
    }
  }

  // RD-COMMS-P2-B — one job per campaign: a pointer to an existing job is driven; otherwise the
  // right to BUILD it is claimed atomically, so two drivers (a send, the sweep, two cron runners)
  // can never build two jobs — every recipient messaged twice.
  if (jobId && !(await jobExists(WHATSAPP_BROADCAST_JOBS, jobId))) jobId = undefined
  let buildJobId: string | null = null
  if (!jobId) {
    const claim = await claimBroadcastJob(ref, 'whatsapp', WHATSAPP_BROADCAST_JOBS)
    if (claim.kind === 'busy' || claim.kind === 'not_sending') return
    if (claim.kind === 'adopt') jobId = claim.jobId
    else buildJobId = claim.jobId
  }

  if (!jobId && buildJobId) {
    // Recipients: same audience query; require a phone. Email suppression is an
    // email-channel concept and does not apply to WhatsApp (opt-out is WA-2/WA-5).
    let regsQuery = adminDb.collection('registrations')
      .where('organizerUid', '==', uid)
      .where('eventSlug',    '==', c.eventSlug) as FirebaseFirestore.Query
    if (c.audience !== 'all') regsQuery = regsQuery.where('status', '==', c.audience)
    // RD-BCAST-DATE-01 — same persisted window, same placement: in the query, before the
    // limit. Shared with email because it filters REGISTRATIONS; the channel-specific
    // parts (phone presence, dedupePhones) stay below and stay WhatsApp-only.
    regsQuery = applyRegistrationDateRange(regsQuery, persistedDateBounds(c.registeredFrom, c.registeredTo))
    // RD-ORGANIZER-04 P1-1: bound the snapshot load to cap+1 (never the whole collection).
    const maxRecipients = await resolveMaxRecipientsPerBroadcast(uid)
    const regsSnap = await regsQuery.limit(maxRecipients + 1).get()
    // RD-COMMS-CAPACITY-UX (L3) — a 'confirmed' audience never includes a completed refund.
    const withPhone: Recipient[] = applyAudienceRefundRule(c.audience, regsSnap.docs
      .map(d => ({ id: d.id, data: d.data() as RegistrationDocument })))
      .filter(({ data }) => typeof data.attendee.phone === 'string' && data.attendee.phone.trim().length > 0)

    // 'Ignore duplicate WhatsApp numbers' — applied HERE, before the job snapshot, because
    // the snapshot IS the idempotency boundary: `createWhatsAppBroadcastJob` writes one row
    // per recipient and every resume pages that subcollection. Deduping later would either
    // desynchronise the cursor or re-resolve on resume and undo itself. Deduping earlier —
    // at creation — is also done, so the billed count and this snapshot agree.
    //
    // Reads the flag off the persisted campaign, so an immediate send and a scheduled one
    // resolved by the cron behave identically.
    // RD-COMMS-WA-CONSENT — re-applied when the audience is resolved for sending (a scheduled
    // campaign is resolved long after creation): explicit opt-in, no STOP. The send boundary
    // re-checks each recipient again immediately before Meta.
    const { eligible: consenting } = await filterWhatsAppBroadcastRecipients(withPhone)
    const audience: Recipient[] = c.dedupePhones
      ? dedupeRecipientsByPhone(consenting)
      : consenting
    // RD-INTEG — never message more people than were paid for. A SCHEDULED campaign is charged
    // for the count previewed at creation, and the audience is resolved again now; anyone who
    // registered in between is beyond the charge. (Fewer is fine: settlement returns the rest.)
    // RD-COMMS-P2-A — no recorded charge is NEVER "no cap": every WhatsApp campaign that starts now
    // records the units it paid for (capacity or legacy balance); one that did not paid for none.
    const paidFor = typeof c.chargedUnits === 'number' && c.chargedUnits >= 0 ? Math.floor(c.chargedUnits) : 0
    const recipients: Recipient[] = audience.length > paidFor ? audience.slice(0, paidFor) : audience
    if (recipients.length < audience.length) {
      await ref.update({ unbilledRecipientsSkipped: audience.length - recipients.length })
    }

    const provider      = await getMetaProvider()
    const validTemplate = typeof c.templateType === 'string' && hasWhatsAppTemplate(c.templateType)

    // No provider / no template / no recipients — resolve immediately (no job).
    if (!provider || !validTemplate || recipients.length === 0) {
      const finalStatus = recipients.length === 0 ? 'sent' : 'failed'
      const failReason  = !provider ? 'provider_unavailable' : !validTemplate ? 'invalid_template' : undefined
      // RD-COMMS-P2-B — status-guarded: a campaign cancelled meanwhile stays cancelled.
      const moved = await transitionCampaign(ref, ['sending'], {
        status: finalStatus, successCount: 0, failCount: recipients.length,
        sentAt: FieldValue.serverTimestamp(), ...(failReason ? { failReason } : {}),
        whatsappJobId: FieldValue.delete(), jobPreparingAt: FieldValue.delete(),
      })
      if (moved) void logBroadcastAction({
        organizerUid: uid, actorUid, campaignId,
        action: finalStatus === 'sent' ? 'broadcast.sent' : 'broadcast.failed',
        metadata: { recipientCount: recipients.length, reason: failReason },
      }).catch(() => {})
      // RD-INTEG · D3 — nothing reached WhatsApp: every unit/rupee charged upfront goes back.
      try { await settleBroadcastBilling(campaignId, 0) }
      catch (err) { console.error('[broadcast] billing settlement failed — the sweep retries it:', { campaignId, err: err instanceof Error ? err.message : err }) }
      return
    }

    // Recipients first, job document last, only while the campaign is still sending.
    const job = await createWhatsAppBroadcastJob(campaignId, c, recipients, { jobId: buildJobId, campaignRef: ref })
    if (!job) return                                 // cancelled while it was being built (the sweep settles it)
    jobId = job.jobId
  }
  if (!jobId) return

  // Drive the first chunk now; the cron completes the rest (resumable/cancellable).
  await processWhatsAppBroadcastChunk(jobId)
}
