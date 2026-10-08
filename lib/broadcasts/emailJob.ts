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

import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { getJob } from '@/lib/jobs/kernel'
import { buildBroadcastJob, broadcastJobIdFor, transitionCampaign } from './jobPreparation'
import { broadcastExecutionBlock, blockedJobError, blockReasonOf } from './executionGuard'
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
import { buildUnsubscribeUrl, unsubscribeHeaders } from '@/lib/email/unsubscribeToken'
import { suppressionStatus } from '@/lib/firebase/firestore/emailSuppressionList'
import { SKIP_UNSUBSCRIBED, SKIP_UNDELIVERABLE } from '@/lib/communications/consent'
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

// RD-BROADCAST-RETRY-01 — total send attempts per recipient, counted ACROSS invocations.
//
// WHY EMAIL RETRIES ON A DIFFERENT SIGNAL FROM WHATSAPP. WhatsApp has a structured taxonomy
// (httpStatus + Graph code) so it can tell a definite refusal from an indeterminate timeout.
// SES surfaces only prose here — `normalizeSesError` returns an English sentence, and this
// codebase deliberately refuses to branch on that (see lib/whatsapp/failureReason.ts). So the
// email rule uses the ONE structural signal that is available and unambiguous:
//
//   success:false  → the provider ANSWERED and rejected the message. Nothing was queued.
//   a THROW        → no answer arrived. SES may already have accepted it. Indeterminate.
//
// Only the first is retried. That is strictly narrower than the shared notificationEngine
// retry (which also retries throws) and is why BROADCAST is left in its NON_RETRY_TYPES
// rather than being switched on there — a duplicate bulk email is not worth the convenience.
const EB_MAX_ATTEMPTS = 3
const EB_RETRY_BACKOFF_MS = [200, 400] as const
const ebSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

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
  /** Running total of send attempts. Bounds retry ACROSS invocations. */
  attempts?:      number
  /** Normalized message of the last failure. Observable final state. */
  lastError?:     string
  /** RD-COMMS-P2-D — written just BEFORE a send; cleared by its definite outcome. Found set ⇒ the
   *  attempt was interrupted (crash / lost lease) and the provider may have accepted it. */
  pendingAttemptAt?: unknown
  /** RD-COMMS-P2-D — the send's outcome is unknown (no definite provider answer): never re-sent. */
  indeterminate?: boolean
  /** RD-COMMS-P2-G — not sent: the recipient opted out of this organizer, or the address is
   *  suppressed platform-wide. Final for this broadcast; `skipReason` says which. */
  skipped?:       boolean
  skipReason?:    string
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
// RD-COMMS-P2-B — deterministic job id per campaign, built recipients-FIRST, job-document-LAST
// (lib/broadcasts/jobPreparation.ts). With `campaignRef`, created only while that campaign is still
// sending and still points at it; null ⇒ it stopped meanwhile and no job was created.
export async function createEmailBroadcastJob(
  campaignId: string,
  campaign: EmailCampaignInput,
  recipients: Recipient[],
  opts: { jobId?: string; campaignRef?: FirebaseFirestore.DocumentReference } = {},
): Promise<EmailBroadcastJob | null> {
  const rows: EmailRecipientRow[] = recipients.map(r => ({
    registrationId: r.id,
    email:          r.data.attendee.email,
    name:           r.data.attendee.name,
    ticketCode:     r.data.ticketCode ?? '',
  }))
  return buildBroadcastJob<EmailBroadcastJob>({
    jobsCollection: EMAIL_BROADCAST_JOBS,
    jobId: opts.jobId ?? broadcastJobIdFor('email', campaignId),
    seed: {
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
    rows: rows as unknown as Record<string, unknown>[],
    ...(opts.campaignRef ? { campaign: { ref: opts.campaignRef, kind: 'email' as const } } : {}),
  })
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
      // RD-COMMS-P2-B — every chunk re-checks the authoritative organizer / event / feature state;
      // a blocked broadcast fails (terminal, with its reason) instead of sending on.
      const block = await broadcastExecutionBlock({ organizerUid: job.organizerUid, eventSlug: job.eventSlug, channel: 'email' })
      if (block) return { ok: false, error: blockedJobError(block) }
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
      if (item.skipped) return { ok: true, skipped: true }   // RD-COMMS-P2-G — opted out on an earlier pass

      // RD-COMMS-P2-D — the ONLY safe answer to "did an earlier attempt reach the provider?" when we
      // cannot know is "assume it may have": an interrupted attempt (marker still set — the worker
      // died, or lost its lease, between the send and its outcome write) or an earlier unknown
      // outcome is NEVER sent again. It stays failed + delivery-unknown; nothing re-sends it.
      const recipientRef = adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)
      if (item.indeterminate) return { ok: false, error: 'Delivery status unknown — not re-sent' }
      if (item.pendingAttemptAt) {
        await recipientRef.update({ indeterminate: true, pendingAttemptAt: FieldValue.delete(), lastError: 'Send was interrupted — delivery status unknown' }).catch(() => undefined)
        void writeEmailLog({
          organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
          templateKey: 'broadcast', provider: ctx.emailProviderName, campaignId: job.campaignId,
          recipientEmail: item.email, recipientName: item.name, subject: job.subject, status: 'failed',
          registrationId: item.registrationId, error: 'Send was interrupted — delivery status unknown', deliveryUnknown: true, costPaise: 0,
        })
        return { ok: false, error: 'Delivery status unknown (interrupted send)' }
      }

      // RD-COMMS-P2-G — CONSENT, re-read at the send boundary for every recipient: the audience was
      // filtered when the broadcast was created, but a recipient may opt out (or start bouncing)
      // afterwards — before the job starts, between its pages, before a retry. An opted-out or
      // platform-suppressed address is skipped with its reason and never reaches SES or Resend.
      // If the state cannot be read, the recipient is NOT sent (consent fails closed).
      let consent: { platform: boolean; organizer: boolean }
      try { consent = await suppressionStatus(item.email, job.organizerUid) }
      catch { return { ok: false, error: 'Opt-out status could not be checked; not sent' } }
      if (consent.platform || consent.organizer) {
        const skipReason = consent.platform ? SKIP_UNDELIVERABLE : SKIP_UNSUBSCRIBED
        await recipientRef.update({ skipped: true, skipReason }).catch(() => undefined)
        void writeEmailLog({
          organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
          templateKey: 'broadcast', provider: ctx.emailProviderName, campaignId: job.campaignId,
          recipientEmail: item.email, recipientName: item.name, subject: job.subject, status: 'skipped',
          registrationId: item.registrationId, error: skipReason, costPaise: 0,
        })
        return { ok: true, skipped: true }
      }

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
      const unsubCtx        = { eventSlug: job.eventSlug, kind: 'broadcast' as const }
      const fullHtml        = emailShell(renderedSubject, renderedBody, buildUnsubscribeUrl(item.email, job.organizerUid, unsubCtx), ctx.emailBranding, { hideOwnershipLine: true })
      // One-click unsubscribe (RFC 8058): 'List-Unsubscribe' + 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'.
      const unsubHeaders    = unsubscribeHeaders(item.email, job.organizerUid, unsubCtx)

      let status: 'sent' | 'failed' = 'failed'
      let errorMsg: string | undefined
      let messageId: string | undefined
      let deliveryUnknown = false

      // RD-BROADCAST-RETRY-01 — bounded retry of DEFINITELY-REJECTED sends only.
      //
      // In-page, before the cursor advances past this recipient, so no rewind is ever needed
      // and cursor mechanics cannot produce a duplicate. Bounded across invocations by the
      // stored `attempts` total, so an interrupted page cannot hand a failing recipient a
      // fresh allowance on every resume.
      const priorAttempts = typeof item.attempts === 'number' ? item.attempts : 0
      let   attemptsUsed  = 0
      let   consentStop: string | null = null    // RD-COMMS-P2-G — opted out between two attempts

      if (priorAttempts >= EB_MAX_ATTEMPTS) {
        errorMsg = `Send abandoned after ${priorAttempts} attempts`
      } else {
        // RD-COMMS-P2-D — record the INTENT to send before the provider is called (awaited). If this
        // cannot be recorded, the recipient is not sent this pass (a later pass may retry it).
        try { await recipientRef.update({ pendingAttemptAt: FieldValue.serverTimestamp() }) }
        catch (err) {
          console.error('[email-broadcast] attempt intent not recorded — not sending:', { jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err })
          return { ok: false, error: 'Could not record the send attempt; not sent' }
        }
        const remaining = EB_MAX_ATTEMPTS - priorAttempts
        for (let attempt = 1; attempt <= remaining; attempt++) {
          // RD-COMMS-P2-G — a retry is a NEW send: consent is re-read before it. Unreadable ⇒ no retry.
          if (attempt > 1) {
            try {
              const again = await suppressionStatus(item.email, job.organizerUid)
              if (again.platform || again.organizer) { consentStop = again.platform ? SKIP_UNDELIVERABLE : SKIP_UNSUBSCRIBED; break }
            } catch { break }
          }
          attemptsUsed = attempt
          let indeterminate = false
          let suppressed = false
          try {
            const r = await notificationEngine.send(NotificationType.BROADCAST, { to: item.email, subject: renderedSubject, html: fullHtml, fromName: ctx.fromName, headers: unsubHeaders }, ctx.emailProviderName)
            status    = r.success ? 'sent' : 'failed'
            messageId = r.messageId
            if (r.success) { errorMsg = undefined; break }
            errorMsg = r.error
            // RD-COMMS-P2-D — providers do not throw; they REPORT an unknown outcome (timeout, no
            // answer, 5xx) with `deliveryUnknown`. Only a definite rejection queued nothing.
            indeterminate = r.deliveryUnknown === true
            suppressed    = r.suppressed === true
          } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Unknown error'
            indeterminate = true        // no answer — the provider may already hold it
          }

          // An unknown outcome is never retried: resending it is how one attendee gets the same
          // broadcast twice. A suppressed recipient is final. Only an explicit rejection earns
          // another attempt.
          if (indeterminate) { deliveryUnknown = true; break }
          if (suppressed) break
          if (attempt < remaining) await ebSleep(EB_RETRY_BACKOFF_MS[attempt - 1] ?? 400)
        }
      }

      if (consentStop) {
        // Every attempt so far was a DEFINITE rejection (nothing was delivered); the recipient then
        // opted out, so no further attempt is made. Recorded as a consent skip, not a failure.
        await recipientRef.update({ skipped: true, skipReason: consentStop, pendingAttemptAt: FieldValue.delete(), attempts: priorAttempts + attemptsUsed }).catch(() => undefined)
        void writeEmailLog({
          organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
          templateKey: 'broadcast', provider: ctx.emailProviderName, campaignId: job.campaignId,
          recipientEmail: item.email, recipientName: item.name, subject: renderedSubject, status: 'skipped',
          registrationId: item.registrationId, error: consentStop, costPaise: 0,
        })
        return { ok: true, skipped: true }
      }

      void writeEmailLog({
        organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
        templateKey: 'broadcast', provider: ctx.emailProviderName, campaignId: job.campaignId,
        recipientEmail: item.email, recipientName: item.name,
        subject: renderedSubject, status, registrationId: item.registrationId,
        error: errorMsg, providerMessageId: messageId,
        costPaise: status === 'sent' ? ctx.perMsgCostPaise : 0,
        ...(deliveryUnknown ? { deliveryUnknown: true } : {}),
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
          await recipientRef.update({ sent: true, pendingAttemptAt: FieldValue.delete() })
        } catch (err) {
          console.error('[email-broadcast] sent-flag write failed — resume may re-send:', {
            jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err,
          })
        }
        return { ok: true }
      }

      // RD-BROADCAST-RETRY-01 — persist the running attempt total. This is what bounds retry
      // across invocations and makes the final failure state observable. Best-effort: the
      // emailLog already carries the reason, and the only cost of a lost write is one more
      // bounded attempt on a later resume.
      if (attemptsUsed > 0) {
        try {
          // The attempt has a recorded outcome now: the marker is cleared. An UNKNOWN one is kept as
          // `indeterminate` so that no later pass ever sends it again.
          await recipientRef.update({
              attempts: priorAttempts + attemptsUsed,
              pendingAttemptAt: FieldValue.delete(),
              ...(deliveryUnknown ? { indeterminate: true } : {}),
              ...(errorMsg ? { lastError: errorMsg.slice(0, 300) } : {}),
            })
        } catch (err) {
          console.error('[email-broadcast] retry-state write failed:', {
            jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err,
          })
        }
      }
      return { ok: false, error: errorMsg }
    },

    // Terminal (completed) → the SAME finalizeBroadcast the WhatsApp path uses.
    async onComplete(job) {
      await finalizeEmailCampaign(job)
    },
  }
}

/** Completion of an email campaign from its COMPLETED job (onComplete, and the stuck-campaign sweep). */
export async function finalizeEmailCampaign(job: EmailBroadcastJob): Promise<void> {
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
  const campSnap = await campaignRef.get()
  if (!campSnap.exists) return
  const c = campSnap.data() as FinalizeCampaign

  const recSnap = await adminDb.collection(EMAIL_BROADCAST_JOBS).doc(job.jobId).collection('recipients').get()
  const recipients: FinalizeRecipient[] = recSnap.docs.map(d => {
    const r = d.data() as EmailRecipientRow
    return { id: r.registrationId, data: { attendee: { email: r.email, name: r.name } } }
  })

  // RD-COMMS-P2-G — opted-out / suppressed recipients were deliberately not sent: not a failure.
  const skipped = recSnap.docs.filter(d => (d.data() as EmailRecipientRow).skipped === true).length
  await finalizeBroadcast(campaignRef, job.campaignId, c, job.counts.succeeded, job.counts.failed, recipients, skipped)
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
    // The broadcast crons chain themselves the moment a chunk yields, so the yielding
    // worker hands the lease over instead of holding it for another full leaseMs. Without
    // this the successor always lost the race and the chain died at depth 1.
    releaseLeaseOnHandoff: true,
    // RD-COMMS-P2-B — a failed broadcast job is final: never leased (resumed) again.
    failedIsTerminal: true,
  })
  if (result.status === 'cancelled' || result.status === 'failed') {
    await syncEmailCampaignTerminal(jobId, result.status).catch(() => { /* best-effort */ })
  }
  return result
}

/**
 * A cancelled/failed email job's campaign leaves `sending` — status-GUARDED (only a `sending`
 * campaign moves), so it never overwrites a terminal state another path wrote. Counts are the
 * job's: emails actually sent stay counted; recipients never reached are not counted as sent.
 * Called by the runner hook, the job reaper and the stuck-campaign sweep (RD-COMMS-P2-B).
 */
export async function syncEmailCampaignTerminal(jobId: string, status: 'cancelled' | 'failed'): Promise<void> {
  const job = await getJob<EmailBroadcastJob>(EMAIL_BROADCAST_JOBS, jobId)
  if (!job) return
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
  const failReason = blockReasonOf(job.error) ?? ((typeof job.error === 'string' && job.error) ? job.error : 'provider_unavailable')
  const moved = await transitionCampaign(campaignRef, ['sending'], {
    status:       status === 'cancelled' ? 'cancelled' : 'failed',
    successCount: job.counts.succeeded,
    failCount:    job.counts.failed,
    sentAt:       FieldValue.serverTimestamp(),
    ...(status === 'failed' ? { failReason } : {}),
  })
  if (!moved) return
  void logBroadcastAction({
    organizerUid: job.organizerUid, actorUid: job.createdBy ?? job.organizerUid, campaignId: job.campaignId,
    action: status === 'cancelled' ? 'broadcast.cancelled' : 'broadcast.failed',
    metadata: { successCount: job.counts.succeeded, failCount: job.counts.failed },
  }).catch(() => {})
}
