// WhatsApp broadcast execution on the generic job runner (WA-3). Server-only.
//
// A campaign's WhatsApp send runs as a `whatsappBroadcastJobs/{jobId}` job — its
// recipients snapshotted into a `recipients` subcollection (exactly like
// Registration Import). The generic runner (lib/jobs/runner) supplies leasing,
// cursor paging, per-page commit, cancellation, budgeting and resume; this module
// supplies only the four JobStrategy hooks. Sending REUSES the Meta provider +
// template registry; completion REUSES finalizeBroadcast — no duplicated logic.
//
// Billing is charged UPFRONT (chargeAndStartCampaign, unchanged) so a resumed/re-run
// chunk never double-bills; a per-recipient `sent` flag makes re-processing after an
// interruption never re-send (WhatsApp has no provider-side idempotency).

import crypto            from 'crypto'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { adminDb }       from '@/lib/firebase/admin'
import { createJob as kernelCreateJob, getJob } from '@/lib/jobs/kernel'
import { runJobChunk }   from '@/lib/jobs/runner'
import type { JobStrategy, ProcessResult } from '@/lib/jobs/runner'
import type { Job }      from '@/lib/jobs/types'
import { getMetaProvider, resolveWhatsAppTemplateByType, hasWhatsAppTemplate } from '@/lib/whatsapp'
import type { WhatsAppProvider, WhatsAppTemplateType } from '@/lib/whatsapp'
import { writeEmailLog }     from '@/lib/email-logs/write'
import { validatePhoneNumber } from '@/lib/communication/phone'
import { getEmailAppUrl }   from '@/lib/email/appUrl'
import { logBroadcastAction } from '@/lib/broadcasts/audit'
import { finalizeBroadcast } from './finalize'
import type { FinalizeCampaign, FinalizeRecipient } from './finalize'
import type { RegistrationDocument } from '@/lib/registrations/types'

export const WHATSAPP_BROADCAST_JOBS = 'whatsappBroadcastJobs'

// The runner renews the lease only at commitChunk (once per page), so a page must
// never take longer than the lease — otherwise the lease expires mid-page, a
// concurrent cron re-leases at the un-advanced cursor, and both drivers re-send the
// same recipients (duplicate WhatsApp messages, H1). Sends run sequentially and each
// is bounded by metaApiTimeoutMs (default 10s), so worst-case page time is
// WAB_PAGE_SIZE × 10s; 5 × 10s = 50s stays safely under the 60s lease. With
// WAB_CONCURRENCY the worst case only improves — ceil(5/3) × 10s = 20s.
const WAB_PAGE_SIZE = 5
/**
 * RD-WA-THRU-01 — messages sent in parallel WITHIN a page.
 *
 * Measured, not guessed. A production campaign (job wab_c929d80e, 385/1472) showed a
 * median inter-message cost of 392 ms and ~77 messages per invocation; a scaled
 * reproduction of that latency gives 75/chunk at 1 and 180/chunk at 3.
 *
 * WHY 3 AND NOT 4. The pool runs inside a page, and pages are WAB_PAGE_SIZE = 5.
 * ceil(5/3) and ceil(5/4) are both two rounds, so 4 opens an extra simultaneous
 * connection to Meta and delivers nothing for it. 5 would be one round and roughly
 * twice as fast again — deliberately not taken, because it triples the instantaneous
 * send rate and NO Meta throughput limit is recorded anywhere in this codebase or its
 * configuration (integrations policy carries only metaApiVersion and metaApiTimeoutMs).
 * Raising it further is a decision to make against a documented account limit, not
 * against an assumption.
 *
 * Safe to raise at all only because processItem is independent and idempotent per
 * recipient: its own row, its own `sent` marker, no wallet debit (the campaign is
 * charged once, upfront, under a deterministic ledger id).
 */
const WAB_CONCURRENCY = 3
const WAB_BUDGET_MS = 45_000
const WAB_LEASE_MS  = 60_000

// whatsappBroadcastJobs/{jobId} — generic control fields (Job) + campaign payload.
export interface WhatsAppBroadcastJob extends Job {
  campaignId:      string
  eventId:         string
  eventSlug:       string
  eventName:       string
  subject:         string
  templateType:    string
  languageCode?:   string
  variables?:      Record<string, string>
  actualCostPaise: number
}

// whatsappBroadcastJobs/{jobId}/recipients/{seq} — a snapshot at job-creation time.
interface WhatsAppRecipientRow {
  registrationId: string
  phone:          string
  name:           string
  email:          string
  ticketCode:     string
  sent?:          boolean
  wamid?:         string
}

// Only the campaign fields job-creation needs (send.ts CampaignData is a superset;
// typed locally to avoid a circular import with send.ts).
interface WhatsAppCampaignInput {
  organizerUid:    string
  createdBy?:      string
  eventId:         string
  eventSlug:       string
  eventName:       string
  subject:         string
  templateType?:   string
  languageCode?:   string
  variables?:      Record<string, string>
  actualCostPaise: number
}

type Recipient = { id: string; data: RegistrationDocument }

// ─── Job creation (snapshot recipients) ───────────────────────────────────────
export async function createWhatsAppBroadcastJob(
  campaignId: string,
  campaign: WhatsAppCampaignInput,
  recipients: Recipient[],
): Promise<WhatsAppBroadcastJob> {
  const jobId = `wab_${crypto.randomUUID()}`

  const job = await kernelCreateJob<WhatsAppBroadcastJob>(
    WHATSAPP_BROADCAST_JOBS,
    jobId,
    {
      organizerUid:    campaign.organizerUid,
      createdBy:       campaign.createdBy ?? campaign.organizerUid,
      campaignId,
      eventId:         campaign.eventId,
      eventSlug:       campaign.eventSlug,
      eventName:       campaign.eventName,
      subject:         campaign.subject,
      templateType:    campaign.templateType ?? '',
      ...(campaign.languageCode ? { languageCode: campaign.languageCode } : {}),
      variables:       campaign.variables ?? {},
      actualCostPaise: campaign.actualCostPaise ?? 0,
    },
    recipients.length,
  )

  const col = adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(jobId).collection('recipients')
  for (let i = 0; i < recipients.length; i += 400) {
    const batch = adminDb.batch()
    for (let j = i; j < Math.min(i + 400, recipients.length); j++) {
      const r = recipients[j]
      const row: WhatsAppRecipientRow = {
        registrationId: r.id,
        phone:          (r.data.attendee.phone ?? '').trim(),
        name:           r.data.attendee.name,
        email:          r.data.attendee.email,
        ticketCode:     r.data.ticketCode ?? '',
      }
      batch.set(col.doc(`r${String(j).padStart(7, '0')}`), row)
    }
    await batch.commit()
  }

  return job
}

// ─── Strategy ──────────────────────────────────────────────────────────────────

interface WhatsAppJobContext {
  provider:        WhatsAppProvider
  templateType:    WhatsAppTemplateType
  languageCode?:   string
  staticVars:      Record<string, string>
  eventName:       string
  /** RD-WA-BROADCAST-02 — this event's public Certificate Center, derived server-side. */
  certificateUrl:  string
  perMsgCostPaise: number
}

type RecipientItem = WhatsAppRecipientRow & { __id: string }

export function whatsAppBroadcastStrategy(): JobStrategy<WhatsAppBroadcastJob, WhatsAppJobContext, RecipientItem> {
  return {
    // Load once: provider + template + language + static variables + per-msg cost.
    async loadContext(job) {
      const provider = await getMetaProvider()
      if (!provider) return { ok: false, error: 'WhatsApp provider is not configured' }
      if (!hasWhatsAppTemplate(job.templateType)) return { ok: false, error: 'WhatsApp template is no longer available' }
      const total = job.counts.total || 1
      return {
        ok: true,
        ctx: {
          provider,
          templateType:    job.templateType,   // narrowed by hasWhatsAppTemplate
          languageCode:    job.languageCode,
          staticVars:      job.variables ?? {},
          eventName:       job.eventName,
          certificateUrl:  `${getEmailAppUrl()}/events/${job.eventSlug}/certificates`,
          perMsgCostPaise: Math.round((job.actualCostPaise ?? 0) / total),
        },
      }
    },

    // Page the recipients subcollection by document id; resume from the cursor.
    async fetchPage(job, _ctx, cursor, limit) {
      let q = adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(job.jobId).collection('recipients')
        .orderBy(FieldPath.documentId())
      if (cursor) q = q.startAfter(cursor)
      q = q.limit(limit)
      const snap = await q.get()
      return {
        items:      snap.docs.map(d => ({ ...(d.data() as WhatsAppRecipientRow), __id: d.id })),
        nextCursor: snap.docs.length ? snap.docs[snap.docs.length - 1].id : cursor,
        hasMore:    snap.size === limit,
      }
    },

    // Resolve variables → resolve template → provider.sendTemplate() → emailLogs.
    // A recipient already marked `sent` (a prior interrupted chunk) is skipped —
    // this is what makes resume/re-run never send twice.
    async processItem(item, job, ctx) {
      if (item.sent) return { ok: true }

      // Validate + normalize the recipient phone (adds the country code) exactly like
      // the transactional WhatsApp paths — a raw/bare number is rejected or misrouted
      // by Meta. Invalid numbers are logged failed and never sent (charged 0), never
      // handed to Meta.
      const phoneCheck = validatePhoneNumber(item.phone)
      if (!phoneCheck.valid) {
        void writeEmailLog({
          organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
          templateKey: 'broadcast', channel: 'whatsapp', provider: 'meta', campaignId: job.campaignId,
          recipientEmail: item.email, recipientName: item.name, recipientPhone: item.phone,
          subject: job.subject, status: 'failed', registrationId: item.registrationId,
          error: `Invalid phone number: ${phoneCheck.reason}`, costPaise: 0,
        })
        return { ok: false, error: `Invalid phone: ${phoneCheck.reason}` }
      }
      const normalizedPhone = phoneCheck.normalizedPhone as string

      const vars: Record<string, string> = {
        ...ctx.staticVars,
        attendeeName: item.name,
        eventName:    ctx.eventName,
        ticketCode:   item.ticketCode ?? '',
        // RD-WA-BROADCAST-02 — SERVER-DERIVED, and deliberately last so it overrides any
        // same-named value that reached `staticVars`. The Certificate Center link must
        // always be this deployment's canonical origin for THIS event; an organizer-typed
        // URL could be a preview host, a stale slug, or another event entirely.
        certificateUrl: ctx.certificateUrl,
      }
      const resolved = resolveWhatsAppTemplateByType(ctx.templateType, normalizedPhone, vars, { languageCode: ctx.languageCode })

      let status: 'sent' | 'failed' = 'failed'
      let errorMsg: string | undefined
      let messageId: string | undefined
      let providerResponse: string | undefined

      if (!resolved.ok) {
        errorMsg = resolved.error
      } else {
        try {
          const r = await ctx.provider.sendTemplate(resolved.message)
          status    = r.success ? 'sent' : 'failed'
          messageId = r.messageId
          if (!r.success) {
            errorMsg = r.error
            providerResponse = r.providerMessage ? `code ${r.code ?? '?'} · ${r.providerMessage}` : undefined
          }
        } catch (err) {
          errorMsg = err instanceof Error ? err.message : 'Unknown error'
        }
      }

      // Unified communication log (emailLogs, channel='whatsapp'); campaignId ties it
      // to the campaign for WA-2 delivery reporting + WA-4 billing reconciliation.
      void writeEmailLog({
        organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
        templateKey: 'broadcast', channel: 'whatsapp', provider: 'meta', campaignId: job.campaignId,
        recipientEmail: item.email, recipientName: item.name, recipientPhone: item.phone,
        subject: job.subject, status, registrationId: item.registrationId,
        error: errorMsg, providerMessageId: messageId, providerResponse,
        costPaise: status === 'sent' ? ctx.perMsgCostPaise : 0,
      })

      if (status === 'sent') {
        // RD-JOB-CONT-01 — mark sent BEFORE counting, and AWAIT it.
        //
        // The comment above this line used to claim "before counting" while the write was
        // `void … .catch(() => {})` — not awaited, failures swallowed. That had to become
        // true before automatic continuation made resumes routine.
        //
        // What a duplicate here actually costs: a second Meta message (a real external
        // charge) and a second notification to the attendee. It does NOT double-debit the
        // wallet — the campaign is charged once, upfront, by chargeAndStartCampaign under a
        // deterministic ledger id, and `perMsgCostPaise` below is a LOG field, not a debit.
        //
        // A write failure is reported but the item still counts as SENT: Meta accepted it.
        // Re-queuing it would guarantee the duplicate this guard exists to avoid.
        try {
          await adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)
            .update({ sent: true, ...(messageId ? { wamid: messageId } : {}) })
        } catch (err) {
          console.error('[whatsapp-broadcast] sent-flag write failed — resume may re-send:', {
            jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err,
          })
        }
        return { ok: true }
      }
      return { ok: false, error: errorMsg }
    },

    // Terminal (completed) → the SAME finalizeBroadcast the email path uses.
    async onComplete(job) {
      const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
      const campSnap = await campaignRef.get()
      if (!campSnap.exists) return
      const c = campSnap.data() as FinalizeCampaign

      const recSnap = await adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(job.jobId).collection('recipients').get()
      const recipients: FinalizeRecipient[] = recSnap.docs.map(d => {
        const r = d.data() as WhatsAppRecipientRow
        return { id: r.registrationId, data: { attendee: { email: r.email, name: r.name } } }
      })

      await finalizeBroadcast(campaignRef, job.campaignId, c, job.counts.succeeded, job.counts.failed, recipients)
    },
  }
}

// ─── Public entry point ─────────────────────────────────────────────────────────

/** Advances one chunk via the generic runner. On a terminal cancel/fail, syncs the
 *  campaign doc (the runner's onComplete only fires for `completed`). */
export async function processWhatsAppBroadcastChunk(jobId: string): Promise<ProcessResult> {
  const result = await runJobChunk(jobId, whatsAppBroadcastStrategy(), {
    collection: WHATSAPP_BROADCAST_JOBS,
    pageSize:    WAB_PAGE_SIZE,
    budgetMs:    WAB_BUDGET_MS,
    leaseMs:     WAB_LEASE_MS,
    concurrency: WAB_CONCURRENCY,
  })
  if (result.status === 'cancelled' || result.status === 'failed') {
    await syncCampaignTerminal(jobId, result.status).catch(() => { /* best-effort */ })
  }
  return result
}

// A cancelled/failed job is not `completed`, so onComplete never runs — reflect the
// terminal state (with counts so far) onto the campaign doc.
async function syncCampaignTerminal(jobId: string, status: 'cancelled' | 'failed'): Promise<void> {
  const job = await getJob<WhatsAppBroadcastJob>(WHATSAPP_BROADCAST_JOBS, jobId)
  if (!job) return
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
  const snap = await campaignRef.get()
  if (!snap.exists || (snap.data() as { status?: string }).status !== 'sending') return   // already finalized

  await campaignRef.update({
    status:       status === 'cancelled' ? 'cancelled' : 'failed',
    successCount: job.counts.succeeded,
    failCount:    job.counts.failed,
    sentAt:       FieldValue.serverTimestamp(),
    ...(status === 'failed' ? { failReason: (typeof job.error === 'string' && job.error) ? job.error : 'delivery_failed' } : {}),
  })
  void logBroadcastAction({
    organizerUid: job.organizerUid, actorUid: job.createdBy ?? job.organizerUid, campaignId: job.campaignId,
    action: status === 'cancelled' ? 'broadcast.cancelled' : 'broadcast.failed',
    metadata: { successCount: job.counts.succeeded, failCount: job.counts.failed },
  }).catch(() => {})
}
