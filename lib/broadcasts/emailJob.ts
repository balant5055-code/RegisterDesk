// Email broadcast execution on the generic job runner (OE-2). Server-only.
//
// Mirrors the WhatsApp broadcast job (WA-3): a campaign's email send runs as an
// `emailBroadcastJobs/{jobId}` job with its recipients snapshotted into a
// `recipients` subcollection. The generic runner (lib/jobs/runner) supplies
// leasing, cursor paging, per-page commit, cancellation, budgeting and resume;
// this module supplies only the four JobStrategy hooks. Sending REUSES the existing
// notification engine (SES via NotificationType.BROADCAST) + email shell; completion
// REUSES finalizeBroadcast — no duplicated SES logic.
//
// Email is free (no wallet charge), so there is no billing to double-charge; a
// per-recipient `sent` flag makes a resumed/re-run chunk never re-send.

import crypto            from 'crypto'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult } from '@/lib/jobs/runner'
import type { Job }      from '@/lib/jobs/types'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import type { EmailProviderName } from '@/lib/email/providerName'
import { emailShell }              from '@/lib/email/templates/base'
import { substituteVariables }     from '@/lib/email-templates/types'
import { renderBroadcastBody }     from '@/lib/broadcasts/renderBody'
import { writeEmailLog }           from '@/lib/email-logs/write'
import { buildUnsubscribeUrl, buildUnsubscribeApiUrl } from '@/lib/email/unsubscribeToken'
import { resolvePublicBranding }   from '@/lib/branding/service'
import { logBroadcastAction }      from '@/lib/broadcasts/audit'
import { finalizeBroadcast }       from './finalize'
import type { FinalizeCampaign, FinalizeRecipient } from './finalize'
import type { RegistrationDocument } from '@/lib/registrations/types'

export const EMAIL_BROADCAST_JOBS = 'emailBroadcastJobs'

// A page must finish within the lease (and the route's maxDuration=60), else the
// worker is killed mid-page, the chunk never commits, and every tick re-processes
// the same page (a wedge) — relying on the best-effort `sent` flag to avoid dup
// emails. Sends run sequentially and each is bounded by SES_TIMEOUT_MS (20s), so
// worst-case page = EB_PAGE_SIZE × 20s; 2 × 20s = 40s stays under the 60s lease.
// (Mirrors the whatsappJob WAB_PAGE_SIZE sizing; the F1 kernel fencing separately
// blocks any double-commit if the invariant is ever violated.)
const EB_PAGE_SIZE = 2
const EB_BUDGET_MS = 45_000
const EB_LEASE_MS  = 60_000

export interface EmailBroadcastJob extends Job {
  campaignId:      string
  eventId:         string
  eventSlug:       string
  eventName:       string
  subject:         string
  html:            string
  actualCostPaise: number
}

interface EmailRecipientRow {
  registrationId: string
  email:          string
  name:           string
  ticketCode:     string
  sent?:          boolean
}

// send.ts CampaignData is a superset; typed locally to avoid a circular import.
interface EmailCampaignInput {
  organizerUid:    string
  createdBy?:      string
  eventId:         string
  eventSlug:       string
  eventName:       string
  subject:         string
  html:            string
  actualCostPaise: number
}

type Recipient = { id: string; data: RegistrationDocument }

// ─── Job creation (snapshot recipients) ───────────────────────────────────────
export async function createEmailBroadcastJob(
  campaignId: string,
  campaign: EmailCampaignInput,
  recipients: Recipient[],
): Promise<EmailBroadcastJob> {
  const jobId = `eb_${crypto.randomUUID()}`

  const job = await kernelCreateJob<EmailBroadcastJob>(
    EMAIL_BROADCAST_JOBS,
    jobId,
    {
      organizerUid:    campaign.organizerUid,
      createdBy:       campaign.createdBy ?? campaign.organizerUid,
      campaignId,
      eventId:         campaign.eventId,
      eventSlug:       campaign.eventSlug,
      eventName:       campaign.eventName,
      subject:         campaign.subject,
      html:            campaign.html,
      actualCostPaise: campaign.actualCostPaise ?? 0,
    },
    recipients.length,
  )

  const col = adminDb.collection(EMAIL_BROADCAST_JOBS).doc(jobId).collection('recipients')
  for (let i = 0; i < recipients.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, recipients.length); j++) {
      const r = recipients[j]
      const row: EmailRecipientRow = {
        registrationId: r.id,
        email:          r.data.attendee.email,
        name:           r.data.attendee.name,
        ticketCode:     r.data.ticketCode ?? '',
      }
      batch.set(col.doc(`r${String(j).padStart(7, '0')}`), row)
    }
    await batch.commit()
  }

  return job
}

// ─── Strategy ──────────────────────────────────────────────────────────────────

interface EmailJobContext {
  emailBranding?:  { companyName: string | null; primaryColor: string | null; hideRegisterDeskBranding: boolean }
  fromName?:       string
  perMsgCostPaise: number
  /** RD-EMAIL-PROVIDER — resolved ONCE per job from this broadcast's own event. */
  emailProviderName: EmailProviderName
}

type RecipientItem = EmailRecipientRow & { __id: string }

export function emailBroadcastStrategy(): JobStrategy<EmailBroadcastJob, EmailJobContext, RecipientItem> {
  return {
    // Load once: this event's transport + its availability + white-label branding + per-msg cost.
    async loadContext(job) {
      // RD-EMAIL-PROVIDER — a broadcast belongs to ONE event, so its provider is resolved
      // once per job from that event, never globally. A broadcast for an SES event still
      // uses SES even while another event is on Resend. Resolved BEFORE the gate so the
      // gate asks about the transport this job will actually use.
      const emailProviderName = await resolveEventEmailProvider(job.eventSlug)
      if (!notificationEngine.isAvailable(NotificationChannel.EMAIL, emailProviderName)) {
        return { ok: false, error: 'Email provider is not configured' }
      }
      const branding = await resolvePublicBranding(job.organizerUid)
      const total = job.counts.total || 1
      return {
        ok: true,
        ctx: {
          emailBranding: branding
            ? { companyName: branding.companyName, primaryColor: branding.primaryColor, hideRegisterDeskBranding: branding.hideRegisterDeskBranding }
            : undefined,
          fromName:        branding?.emailSenderName ?? undefined,
          emailProviderName,
          perMsgCostPaise: Math.round((job.actualCostPaise ?? 0) / total),
        },
      }
    },

    async fetchPage(job, _ctx, cursor, limit) {
      let q = adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients')
        .orderBy(FieldPath.documentId())
      if (cursor) q = q.startAfter(cursor)
      q = q.limit(limit)
      const snap = await q.get()
      return {
        items:      snap.docs.map(d => ({ ...(d.data() as EmailRecipientRow), __id: d.id })),
        nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
        hasMore:    snap.size === limit,
      }
    },

    // Resolve variables → render → SES send → emailLogs. A recipient already marked
    // `sent` (a prior interrupted chunk) is skipped — no duplicate email.
    async processItem(item, job, ctx) {
      if (item.sent) return { ok: true }

      const vars: Record<string, string> = {
        attendeeName: item.name, eventName: job.eventName, ticketCode: item.ticketCode,
        registrationId: item.registrationId, organizerName: '', eventDate: '', eventLocation: '',
      }
      const renderedSubject = substituteVariables(job.subject, vars)
      // RD-BCAST-FMT-01 — the shared body renderer (line breaks + escaped substitution).
      // The composer preview and Send Test call this same function, so what the organizer
      // approved is what the attendee receives.
      const renderedBody    = renderBroadcastBody(job.html, vars)
      // hideOwnershipLine: a broadcast is the organizer's voice to their own audience, so
      // the operating-entity line comes off. "Powered by RegisterDesk" and the visible
      // unsubscribe link both stay — the latter is what makes this mail honest.
      const fullHtml        = emailShell(renderedSubject, renderedBody, buildUnsubscribeUrl(item.email, job.organizerUid), ctx.emailBranding, { hideOwnershipLine: true })
      const unsubHeaders: Record<string, string> = {
        'List-Unsubscribe':      `<${buildUnsubscribeApiUrl(item.email, job.organizerUid)}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      }

      let status: 'sent' | 'failed' = 'failed'
      let errorMsg: string | undefined
      let messageId: string | undefined
      try {
        const r = await notificationEngine.send(NotificationType.BROADCAST, { to: item.email, subject: renderedSubject, html: fullHtml, fromName: ctx.fromName, headers: unsubHeaders }, ctx.emailProviderName)
        status    = r.success ? 'sent' : 'failed'
        messageId = r.messageId
        if (!r.success) errorMsg = r.error
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : 'Unknown error'
      }

      void writeEmailLog({
        organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
        templateKey: 'broadcast', provider: ctx.emailProviderName, campaignId: job.campaignId,
        recipientEmail: item.email, recipientName: item.name,
        subject: renderedSubject, status, registrationId: item.registrationId,
        error: errorMsg, providerMessageId: messageId,
        costPaise: status === 'sent' ? ctx.perMsgCostPaise : 0,
      })

      if (status === 'sent') {
        // RD-JOB-CONT-01 — AWAITED, not fire-and-forget.
        //
        // This flag is the ONLY thing standing between a resumed chunk and a second copy
        // of the same email. It used to be `void … .catch(() => {})`: the write was not
        // waited for and its failure was swallowed, so an invocation that died between
        // the send and the write left the recipient unmarked and they were mailed again
        // on resume. Automatic continuation makes resumes routine rather than rare, so
        // that window had to close before the chain was switched on.
        //
        // A write failure is reported but the item still counts as SENT, because it was:
        // the attendee has the email. Counting it failed would be a lie and would queue
        // a retry — the exact duplicate this guards against.
        try {
          await adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)
            .update({ sent: true })
        } catch (err) {
          console.error('[email-broadcast] sent-flag write failed — resume may re-send:', {
            jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err,
          })
        }
        return { ok: true }
      }
      return { ok: false, error: errorMsg }
    },

    // Terminal (completed) → the SAME finalizeBroadcast the WhatsApp path uses.
    async onComplete(job) {
      const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
      const campSnap = await campaignRef.get()
      if (!campSnap.exists) return
      const c = campSnap.data() as FinalizeCampaign

      const recSnap = await adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients').get()
      const recipients: FinalizeRecipient[] = recSnap.docs.map(d => {
        const r = d.data() as EmailRecipientRow
        return { id: r.registrationId, data: { attendee: { email: r.email, name: r.name } } }
      })

      await finalizeBroadcast(campaignRef, job.campaignId, c, job.counts.succeeded, job.counts.failed, recipients)
    },
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────────

/** Advances one chunk via the generic runner. On a terminal cancel/fail, syncs the
 *  campaign doc (the runner's onComplete only fires for `completed`). */
export async function processEmailBroadcastChunk(jobId: string): Promise<ProcessResult> {
  const result = await runJobChunk(jobId, emailBroadcastStrategy(), {
    collection: EMAIL_BROADCAST_JOBS,
    pageSize:   EB_PAGE_SIZE,
    budgetMs:   EB_BUDGET_MS,
    leaseMs:    EB_LEASE_MS,
  })
  if (result.status === 'cancelled' || result.status === 'failed') {
    await syncCampaignTerminal(jobId, result.status).catch(() => { /* best-effort */ })
  }
  return result
}

async function syncCampaignTerminal(jobId: string, status: 'cancelled' | 'failed'): Promise<void> {
  const job = await getJob<EmailBroadcastJob>(EMAIL_BROADCAST_JOBS, jobId)
  if (!job) return
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
  const snap = await campaignRef.get()
  if (!snap.exists || (snap.data() as { status?: string }).status !== 'sending') return

  await campaignRef.update({
    status:       status === 'cancelled' ? 'cancelled' : 'failed',
    successCount: job.counts.succeeded,
    failCount:    job.counts.failed,
    sentAt:       FieldValue.serverTimestamp(),
    ...(status === 'failed' ? { failReason: (typeof job.error === 'string' && job.error) ? job.error : 'provider_unavailable' } : {}),
  })
  void logBroadcastAction({
    organizerUid: job.organizerUid, actorUid: job.createdBy ?? job.organizerUid, campaignId: job.campaignId,
    action: status === 'cancelled' ? 'broadcast.cancelled' : 'broadcast.failed',
    metadata: { successCount: job.counts.succeeded, failCount: job.counts.failed },
  }).catch(() => {})
}
