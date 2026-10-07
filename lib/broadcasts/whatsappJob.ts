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
import { validatePhoneNumber } from '@/lib/communication/phone'
// RD-BROADCAST-RETRY-01 — the EXISTING failure taxonomy. No new classifier was created; the
// narrow auto-resend predicate lives beside it because retry safety is a property of the
// taxonomy, not of this job.
import { classifyWhatsAppFailure, isRetryableWhatsAppFailure } from '@/lib/whatsapp/failureReason'
import { getEmailAppUrl }   from '@/lib/email/appUrl'
import { logBroadcastAction } from '@/lib/broadcasts/audit'
import { finalizeBroadcast } from './finalize'
import { settleBroadcastBilling } from '@/lib/communications/billing'
import { callbackDataFor, recordBroadcastAcceptance, withPersistRetry, messageLogId } from '@/lib/whatsapp/acceptance'
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

// RD-BROADCAST-RETRY-01 — total send attempts per recipient, counted ACROSS invocations (the
// row carries the running total), so a recipient that fails on every resume cannot be retried
// forever. Backoff is deliberately small: at most 250+750ms per failing recipient, which keeps
// a full page of failures inside the 15s of headroom between WAB_BUDGET_MS and WAB_LEASE_MS.
// Neither WAB_BUDGET_MS, WAB_LEASE_MS, WAB_PAGE_SIZE nor WAB_CONCURRENCY is changed for this.
const WAB_MAX_ATTEMPTS = 3
const WAB_RETRY_BACKOFF_MS = [250, 750] as const
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

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
  /** Running total of send attempts. Bounds retry ACROSS invocations. */
  attempts?:      number
  /** Stable failure category of the LAST attempt — observable final state. */
  failureReason?: string
  /** Normalized message of the last failure. Never a raw Meta payload. */
  lastError?:     string
  /**
   * RD-CLOSE — written (awaited) immediately BEFORE the provider call and cleared when the
   * outcome is recorded. Found on a recipient that is not `sent`, it means a previous worker
   * died between handing the message to Meta and recording what Meta said: the message may have
   * been accepted, so it is never re-sent; Meta's status webhook settles it (acceptanceRecovery).
   */
  pendingAttemptAt?: unknown
  /** RD-CLOSE — set when an interrupted attempt was found: indeterminate, never auto-resent. */
  indeterminate?: boolean
}

/** RD-CLOSE — one log row per recipient outcome (deterministic id ⇒ a re-run page never duplicates it). */
async function writeBroadcastLog(id: string, data: Record<string, unknown>): Promise<void> {
  const clean = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))
  await withPersistRetry(() => adminDb.collection('emailLogs').doc(id).set(
    { ...clean, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true },
  ), 3).catch(err => console.error('[whatsapp-broadcast] log write failed:', { id, err: err instanceof Error ? err.message : err }))
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
      const recipientRef = adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(job.jobId).collection('recipients').doc(item.__id)
      const baseLog = {
        organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug, eventName: job.eventName,
        templateKey: 'broadcast', channel: 'whatsapp', provider: 'meta', campaignId: job.campaignId,
        recipientEmail: item.email, recipientName: item.name, recipientPhone: item.phone,
        subject: job.subject, registrationId: item.registrationId,
      }

      // RD-CLOSE — an attempt that a previous worker started and never recorded. Meta may have
      // accepted it, so re-sending could double-message (and double-bill) the attendee. It is
      // left indeterminate; the status webhook records it if Meta accepted it.
      if (item.indeterminate) return { ok: false, error: 'Delivery status unknown (interrupted send)' }
      if (item.pendingAttemptAt) {
        await recipientRef.update({ indeterminate: true, failureReason: 'INTERRUPTED_UNKNOWN', pendingAttemptAt: FieldValue.delete() }).catch(() => undefined)
        await writeBroadcastLog(`bcfail_${job.jobId}_${item.__id}`, { ...baseLog, status: 'failed', deliveryUnknown: true, error: 'Send was interrupted — delivery status unknown', costPaise: 0 })
        return { ok: false, error: 'Delivery status unknown (interrupted send)' }
      }

      // Validate + normalize the recipient phone (adds the country code) exactly like
      // the transactional WhatsApp paths — a raw/bare number is rejected or misrouted
      // by Meta. Invalid numbers are logged failed and never sent (charged 0), never
      // handed to Meta.
      const phoneCheck = validatePhoneNumber(item.phone)
      if (!phoneCheck.valid) {
        await writeBroadcastLog(`bcfail_${job.jobId}_${item.__id}`, { ...baseLog, status: 'failed', error: `Invalid phone number: ${phoneCheck.reason}`, costPaise: 0 })
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

      // RD-BROADCAST-RETRY-01 — bounded retry of DEFINITELY-REFUSED sends only.
      //
      // WHY IN-PAGE, AND NOT BY REWINDING THE CURSOR. The cursor is a document-id watermark
      // that only moves forward; a past recipient is revisited only if the whole page re-runs.
      // Rewinding it to sweep failures would drag every already-sent recipient on that page
      // back through processItem AND re-attempt the indeterminate ones — the precise case that
      // must never be resent. Retrying here, before the cursor advances past this recipient,
      // needs no rewind at all, so cursor mechanics can never cause a duplicate.
      const priorAttempts = typeof item.attempts === 'number' ? item.attempts : 0
      let   attemptsUsed  = 0
      let   failureReason: string | undefined

      if (!resolved.ok) {
        errorMsg = resolved.error
      } else if (priorAttempts >= WAB_MAX_ATTEMPTS) {
        // Already spent its budget on earlier invocations. Not sent, not retried, and — the
        // point of the bound — not allowed to keep consuming the budget of the recipients
        // queued behind it.
        errorMsg      = `Send abandoned after ${priorAttempts} attempts`
        failureReason = 'ATTEMPTS_EXHAUSTED'
      } else {
        // RD-CLOSE — record the intent BEFORE handing anything to Meta (awaited). If it cannot be
        // recorded, nothing is sent: an unrecorded send is exactly what cannot be recovered safely.
        try { await recipientRef.update({ pendingAttemptAt: FieldValue.serverTimestamp() }) }
        catch (err) {
          console.error('[whatsapp-broadcast] attempt intent not recorded — not sending:', { jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err })
          return { ok: false, error: 'Could not record the send attempt; not sent' }
        }
        const message = { ...resolved.message, callbackData: callbackDataFor({ kind: 'broadcast', jobId: job.jobId, recipientId: item.__id }) }
        const remaining = WAB_MAX_ATTEMPTS - priorAttempts
        for (let attempt = 1; attempt <= remaining; attempt++) {
          attemptsUsed = attempt
          let code:       number | undefined
          let httpStatus: number | undefined

          try {
            const r = await ctx.provider.sendTemplate(message)
            status    = r.success ? 'sent' : 'failed'
            messageId = r.messageId
            if (r.success) { errorMsg = undefined; failureReason = undefined; break }
            errorMsg         = r.error
            providerResponse = r.providerMessage ? `code ${r.code ?? '?'} · ${r.providerMessage}` : undefined
            code             = r.code
            httpStatus       = r.httpStatus
          } catch (err) {
            errorMsg = err instanceof Error ? err.message : 'Unknown error'
            // A throw means no response arrived, so httpStatus stays undefined and the
            // classifier below reads it as transport — indeterminate, never auto-resent.
          }

          const reason = classifyWhatsAppFailure({ code, httpStatus, error: errorMsg })
          failureReason = reason

          // Only a verdict Meta actually returned, and only one that says "not accepted",
          // earns another attempt. Timeouts and permanent refusals stop here.
          if (!isRetryableWhatsAppFailure(reason)) break
          if (attempt < remaining) await sleep(WAB_RETRY_BACKOFF_MS[attempt - 1] ?? 750)
        }
      }

      // Unified communication log (emailLogs, channel='whatsapp'); campaignId ties it
      // to the campaign for WA-2 delivery reporting + WA-4 billing reconciliation.
      // RD-CLOSE — deterministic id (one row per accepted wamid / per failed recipient), awaited.
      await writeBroadcastLog(status === 'sent' && messageId ? messageLogId(messageId) : `bcfail_${job.jobId}_${item.__id}`, {
        ...baseLog, status, error: errorMsg, providerMessageId: messageId, providerResponse,
        costPaise: status === 'sent' ? ctx.perMsgCostPaise : 0,
        // No verdict from Meta (transport) ⇒ delivery UNKNOWN, not failed; the webhook resolves it.
        ...(status === 'failed' && (failureReason === 'NETWORK_TIMEOUT' || failureReason === 'NETWORK_ERROR' || failureReason === 'UNKNOWN_ERROR') ? { deliveryUnknown: true } : {}),
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
        // RD-CLOSE — the acceptance record (sent flag + wamid; a late acceptance after settlement is
        // charged back in the same transaction), retried with backoff. If every retry fails the
        // pending-attempt marker stays, so a resume never re-sends; Meta's status webhook replays
        // the same record from the callback data.
        try {
          if (!messageId) throw new Error('accepted without a wamid')
          await withPersistRetry(() => recordBroadcastAcceptance({ jobId: job.jobId, recipientId: item.__id, wamid: messageId!, source: 'send' }))
        } catch (err) {
          console.error('[whatsapp-broadcast] acceptance not persisted — the status webhook will recover it:', {
            jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err,
          })
        }
        return { ok: true }
      }

      // RD-BROADCAST-RETRY-01 — persist the running attempt total and the classification.
      //
      // This write is what makes the bound hold ACROSS invocations. An interrupted page
      // re-runs from the same cursor, so without a stored total a recipient that fails every
      // time would get a fresh full allowance on every resume — an unbounded loop wearing the
      // costume of progress. It is also the observable final state: `failureReason` says why
      // in a symbol the dashboard can branch on, not in prose.
      //
      // Best-effort by design. If it fails the recipient is still counted failed and the
      // emailLog already carries the reason; the only cost is that a later resume may grant
      // this one recipient another attempt, which is bounded anyway.
      if (attemptsUsed > 0 || failureReason) {
        try {
          // RD-CLOSE — a TRANSPORT outcome (no verdict from Meta) may have been accepted: the
          // recipient is indeterminate and is never re-sent, even if this page re-runs; Meta's
          // status webhook records it if it was accepted.
          const transport = failureReason === 'NETWORK_TIMEOUT' || failureReason === 'NETWORK_ERROR' || failureReason === 'UNKNOWN_ERROR'
          await recipientRef
            .update({
              pendingAttemptAt: FieldValue.delete(),
              ...(transport ? { indeterminate: true } : {}),
              attempts: priorAttempts + attemptsUsed,
              ...(failureReason ? { failureReason } : {}),
              ...(errorMsg ? { lastError: errorMsg.slice(0, 300) } : {}),
            })
        } catch (err) {
          console.error('[whatsapp-broadcast] retry-state write failed:', {
            jobId: job.jobId, recipient: item.__id, err: err instanceof Error ? err.message : err,
          })
        }
      }
      return { ok: false, error: errorMsg }
    },

    // Terminal (completed) → the SAME finalizeBroadcast the email path uses.
    async onComplete(job) {
      await finalizeWhatsAppCampaign(job.jobId, job.campaignId)
    },
  }
}

/** Completion of a WhatsApp campaign whose job finished. Also the sweep's recovery path when the
 *  runner's onComplete never ran (a crash after the final commit). */
export async function finalizeWhatsAppCampaign(jobId: string, campaignId: string): Promise<void> {
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(campaignId)
  const campSnap = await campaignRef.get()
  if (!campSnap.exists) return
  const c = campSnap.data() as FinalizeCampaign

  const recSnap = await adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(jobId).collection('recipients').get()
  const recipients: FinalizeRecipient[] = recSnap.docs.map(d => {
    const r = d.data() as WhatsAppRecipientRow
    return { id: r.registrationId, data: { attendee: { email: r.email, name: r.name } } }
  })

  // RD-INTEG — the ACCEPTED count is the recipients marked sent, not the runner's counter:
  // a page re-run after an interrupted commit counts an already-sent (skipped) recipient
  // as a success again, inflating job.counts.succeeded. The sent flags are the truth, and
  // they are what billing is settled on.
  const accepted = recSnap.docs.filter(d => (d.data() as WhatsAppRecipientRow).sent === true).length
  await finalizeBroadcast(campaignRef, campaignId, c, accepted, recipients.length - accepted, recipients)
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
    // The broadcast crons chain themselves the moment a chunk yields, so the yielding
    // worker hands the lease over instead of holding it for another full leaseMs. Without
    // this the successor always lost the race and the chain died at depth 1.
    releaseLeaseOnHandoff: true,
    concurrency: WAB_CONCURRENCY,
  })
  if (result.status === 'cancelled' || result.status === 'failed') {
    await syncCampaignTerminal(jobId, result.status).catch(() => { /* best-effort */ })
  }
  return result
}

// A cancelled/failed job is not `completed`, so onComplete never runs — reflect the
// terminal state (with counts so far) onto the campaign doc.
export async function syncCampaignTerminal(jobId: string, status: 'cancelled' | 'failed'): Promise<void> {
  const job = await getJob<WhatsAppBroadcastJob>(WHATSAPP_BROADCAST_JOBS, jobId)
  if (!job) return
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(job.campaignId)
  const snap = await campaignRef.get()
  if (!snap.exists) return
  // This runs AFTER the worker's last commit, so no recipient of this job can still be sent:
  // the accepted count is final. (The cancel route may already have marked the campaign
  // cancelled while this worker was mid-page — settlement still has to happen, here.)
  const accepted = await countAcceptedRecipients(jobId)
  if ((snap.data() as { status?: string }).status === 'sending') {
    await campaignRef.update({
      status:       status === 'cancelled' ? 'cancelled' : 'failed',
      successCount: accepted,
      failCount:    Math.max(0, job.counts.total - accepted),
      sentAt:       FieldValue.serverTimestamp(),
      ...(status === 'failed' ? { failReason: (typeof job.error === 'string' && job.error) ? job.error : 'delivery_failed' } : {}),
    })
    void logBroadcastAction({
      organizerUid: job.organizerUid, actorUid: job.createdBy ?? job.organizerUid, campaignId: job.campaignId,
      action: status === 'cancelled' ? 'broadcast.cancelled' : 'broadcast.failed',
      metadata: { successCount: accepted, failCount: Math.max(0, job.counts.total - accepted) },
    }).catch(() => {})
  } else {
    // Already marked terminal (the cancel route) — bring its counts to the final truth.
    await campaignRef.update({ successCount: accepted, failCount: Math.max(0, job.counts.total - accepted) })
  }
  // RD-INTEG · D3 — charge on accept: give back everything WhatsApp did not accept.
  await settleBroadcastBilling(job.campaignId, accepted)
}

/** RD-INTEG — recipients WhatsApp ACCEPTED for this job (the `sent` flags; the billing truth). */
export async function countAcceptedRecipients(jobId: string): Promise<number> {
  const agg = await adminDb.collection(WHATSAPP_BROADCAST_JOBS).doc(jobId).collection('recipients')
    .where('sent', '==', true).count().get()
  return agg.data().count
}
