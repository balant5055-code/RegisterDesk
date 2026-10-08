// Reminder dispatcher — server-only. Picks up due reminder jobs, CLAIMS each with
// a status-guarded transition (scheduled → sending) so overlapping cron runs can't
// double-send, then delivers through the EXISTING notification engine
// (NotificationType.CUSTOM_EMAIL) and logs every send to `emailLogs` — no duplicate
// communication code. Email is the live channel; the channel field is reserved for
// WhatsApp/SMS once approved reminder templates exist.
//
// RD-COMMS-P2-E — production-safe execution:
//   • every claimed job passes reminderExecutionBlock (executionGuard.ts) against CURRENT state —
//     organizer, event lifecycle/ownership/date, email switch, reminder switches — or is skipped
//     with that reason (terminal; never retried);
//   • every recipient is re-checked when its page is read: a cancelled, pending, rejected or
//     REFUNDED registration (checkInBlockReason — the one canonical rule) and an address the
//     organizer's attendees unsubscribed from are excluded;
//   • every send first claims its row in the delivery ledger (delivery.ts), so no attendee can get
//     the same reminder twice — not across pages, resumed or concurrent workers, or duplicate jobs;
//   • a large audience is paged with a cursor stored on the job: when the time budget runs out the
//     job goes back to 'scheduled' at its cursor and the next run continues it, and a job whose
//     worker died is resumed up to `retryCount` times (config.ts);
//   • one malformed job is failed on its own; it never stops the rest of the run.
// Email is free: nothing here reads or writes the Communication Balance or a WhatsApp allowance.

import { COMMUNICATION_BALANCE_HREF } from '@/lib/wallet/communicationBalance'
import { FieldValue, Timestamp, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { writeEmailLog } from '@/lib/email-logs/write'
import { fmtEmailDate } from '@/lib/email'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { suppressionStatus } from '@/lib/firebase/firestore/emailSuppressionList'
import { buildUnsubscribeUrl, unsubscribeHeaders } from '@/lib/email/unsubscribeToken'
import { SKIP_UNSUBSCRIBED, SKIP_UNDELIVERABLE } from '@/lib/communications/consent'
import { checkInBlockReason } from '@/lib/registrations/checkinEligibility'
import { APP_URL } from '@/lib/env'
import { buildReminderContent } from './templates'
import { getReminderSettings, type ReminderSettings } from './config'
import { reminderExecutionBlock, type ReminderJobData } from './executionGuard'
import { reminderDeliveryId, claimReminderDelivery, settleReminderDelivery } from './delivery'
import type { ReminderDocData, ReminderStatus } from './types'

const REMINDERS = adminDb.collection('scheduledReminders')
const REMINDER_PAGE = 500     // RD-ORGANIZER-04 P1-4: recipients paged this many at a time
const WAVE = 20               // concurrent sends per wave (mirrors broadcast delivery)
const SEND_LEASE_MS = 10 * 60 * 1000   // a 'sending' reminder older than this is presumed dead
const DEFAULT_BUDGET_MS = 45_000       // stop claiming new work before the 60s function limit
const MAX_GUARD_ERRORS = 3             // a gate that cannot be READ defers the job this many times, then fails it

type Counts = ReminderDocData['counts']

interface Recipient { email: string; name: string; docId?: string }

/** The stored job (P2-E adds the delivery-ledger marker, the page cursor and resume counters). */
type ReminderJob = ReminderJobData & {
  deliveryLedger?: boolean
  cursor?:         unknown
  resumes?:        unknown
  guardErrors?:    unknown
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k] }
  return cur
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
function countsOf(c: unknown): Counts {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>
  return { recipients: num(o.recipients), sent: num(o.sent), failed: num(o.failed), skipped: num(o.skipped) }
}

/** Claim a due reminder: scheduled → sending. Returns the data, or null if another
 *  run already claimed it (status guard = never double-send). Marks the job as using the
 *  delivery ledger, which is what makes it safe to resume later. */
async function claim(id: string): Promise<ReminderJob | null> {
  const ref = REMINDERS.doc(id)
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) return null
    const data = snap.data() as ReminderJob & { status: string }
    if (data.status !== 'scheduled') return null
    txn.update(ref, { status: 'sending', deliveryLedger: true, updatedAt: FieldValue.serverTimestamp() })
    return data
  })
}

async function finalize(id: string, status: ReminderStatus, counts: Counts, error?: string): Promise<void> {
  await REMINDERS.doc(id).set({
    status, counts,
    error: error ?? null,
    dispatchedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** Hand a job we still hold back to 'scheduled' (it stays due, so the next run picks it up). */
async function release(id: string, patch: Record<string, unknown>): Promise<void> {
  const ref = REMINDERS.doc(id)
  await adminDb.runTransaction(async txn => {
    const s = await txn.get(ref)
    if (!s.exists || (s.data() as { status?: unknown }).status !== 'sending') return
    txn.update(ref, { ...patch, status: 'scheduled', updatedAt: FieldValue.serverTimestamp() })
  })
}

/** Resolve the single organizer recipient for an organizer-audience reminder. */
async function resolveOrganizerRecipients(data: ReminderDocData): Promise<Recipient[]> {
  const snap = await adminDb.doc(`users/${data.organizerUid}`).get()
  const u = snap.exists ? (snap.data() as Record<string, unknown>) : {}
  const email = typeof u.email === 'string' ? u.email : ''
  if (!email) return []
  return [{ email, name: typeof u.name === 'string' ? u.name : (typeof u.organizationName === 'string' ? u.organizationName : '') }]
}

interface SendContext {
  id:         string
  data:       ReminderDocData
  logicalKey: string
  subject:    string
  html:       (r: Recipient, unsubscribeUrl?: string) => string
  provider:   Awaited<ReturnType<typeof resolveEventEmailProvider>>
}

/** Send one recipient: suppression → ledger claim → send → settle + log. Never throws. */
async function sendOne(ctx: SendContext, r: Recipient): Promise<'sent' | 'failed' | 'skipped'> {
  const { data } = ctx
  // RD-COMMS-P2-G — CONSENT at the send boundary. An attendee who unsubscribed from this organizer
  // (or whose address is suppressed platform-wide) is not reminded; the skip is logged with its
  // reason, and the provider is never called. Read fresh for every recipient, so an opt-out made
  // after the reminder was scheduled — or between its pages — is honoured. Cannot tell ⇒ not sent.
  let unsubscribeUrl: string | undefined
  let headers: Record<string, string> | undefined
  if (data.audience === 'attendees') {
    let consent: { platform: boolean; organizer: boolean }
    try { consent = await suppressionStatus(r.email, data.organizerUid) }
    catch { return 'failed' }
    if (consent.platform || consent.organizer) {
      void writeEmailLog({
        organizerUid: data.organizerUid, eventId: data.eventId ?? '', eventSlug: data.eventId ?? '',
        eventName: data.eventName, templateKey: 'event_reminder',
        recipientEmail: r.email, recipientName: r.name, subject: ctx.subject,
        status: 'skipped', provider: ctx.provider, channel: 'email',
        error: consent.platform ? SKIP_UNDELIVERABLE : SKIP_UNSUBSCRIBED,
      })
      return 'skipped'
    }
    // Organizer communication ⇒ it carries the recipient's signed opt-out (body link + one-click).
    const unsubCtx = { eventSlug: data.eventId, kind: 'reminder' as const }
    unsubscribeUrl = buildUnsubscribeUrl(r.email, data.organizerUid, unsubCtx)
    headers = unsubscribeHeaders(r.email, data.organizerUid, unsubCtx)
  }

  const deliveryId = reminderDeliveryId(ctx.logicalKey, r.email)
  try {
    const claimed = await claimReminderDelivery(deliveryId, {
      reminderId: ctx.id, logicalKey: ctx.logicalKey, eventId: data.eventId ?? null, organizerUid: data.organizerUid,
    })
    if (claimed === 'exists') return 'skipped'     // already attempted — never resent
  } catch {
    return 'failed'                                 // ledger unwritable — not sent
  }

  let ok = false, unknown = false
  try {
    const result = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: r.email, subject: ctx.subject, html: ctx.html(r, unsubscribeUrl), ...(headers ? { headers } : {}) }, ctx.provider)
    ok = result.success
    unknown = !ok && result.deliveryUnknown === true
    void writeEmailLog({
      organizerUid: data.organizerUid, eventId: data.eventId ?? '', eventSlug: data.eventId ?? '',
      eventName: data.eventName, templateKey: 'event_reminder',
      recipientEmail: r.email, recipientName: r.name, subject: ctx.subject,
      status: ok ? 'sent' : 'failed', provider: ctx.provider, channel: 'email',
      providerMessageId: result.messageId, error: ok ? undefined : (result.errorDetail ?? result.error),
      ...(unknown ? { deliveryUnknown: true } : {}),
    })
  } catch {
    unknown = true      // a throw after the hand-off: the provider may have accepted it
  }
  await settleReminderDelivery(deliveryId, ok ? 'sent' : unknown ? 'unknown' : 'failed')
  return ok ? 'sent' : 'failed'
}

/** Send to a batch of recipients in concurrent WAVEs; adds the tally into `counts`. */
async function sendWave(ctx: SendContext, recipients: Recipient[], counts: Counts): Promise<void> {
  const results = await Promise.all(recipients.map(r => sendOne(ctx, r)))
  counts.recipients += recipients.length
  for (const x of results) counts[x]++
}

/** Build the reminder content (subject/html) for this reminder, from the event doc the gate
 *  just read (so the body always shows the CURRENT date/venue). */
function buildContent(data: ReminderDocData, ev: Record<string, unknown> | null): { subject: string; html: (r: Recipient, unsubscribeUrl?: string) => string } {
  if (data.kind === 'custom') {
    const built = (unsubscribeUrl?: string) => buildReminderContent({ kind: 'custom', eventName: data.eventName, customSubject: data.subject ?? undefined, customMessage: data.message ?? undefined, unsubscribeUrl })
    return { subject: built().subject, html: (_r, unsubscribeUrl) => built(unsubscribeUrl).html }
  }
  if (data.kind === 'low_wallet') {
    const built = (r: Recipient) => buildReminderContent({ kind: 'low_wallet', eventName: data.eventName, recipientName: r.name, eventUrl: `${APP_URL}${COMMUNICATION_BALANCE_HREF}` })
    return { subject: built({ email: '', name: '' }).subject, html: r => built(r).html }
  }
  // Event-anchored kinds — fresh event schedule/venue.
  let dateLabel: string | undefined, timeLabel: string | undefined, venueLabel: string | undefined
  if (ev) {
    const sched = nested(ev, 'eventDetails', 'schedule') as Record<string, unknown> | undefined
    const startDate = typeof sched?.startDate === 'string' ? sched.startDate : ''
    dateLabel = startDate ? (fmtEmailDate(startDate) || startDate) : undefined
    timeLabel = typeof sched?.startTime === 'string' && sched.startTime ? sched.startTime : undefined
    const phys = nested(ev, 'eventDetails', 'venue', 'physical') as Record<string, unknown> | undefined
    const name = typeof phys?.name === 'string' ? phys.name : ''
    const city = typeof phys?.city === 'string' ? phys.city : ''
    venueLabel = [name, city].filter(Boolean).join(', ') || undefined
  }
  const eventUrl = data.eventId ? `${APP_URL}/events/${data.eventId}` : undefined
  const built = (r: Recipient, unsubscribeUrl?: string) => buildReminderContent({
    kind: data.kind, eventName: data.eventName, recipientName: r.name,
    eventDateLabel: dateLabel, eventTimeLabel: timeLabel, venueLabel, eventUrl, unsubscribeUrl,
  })
  return { subject: built({ email: '', name: '' }).subject, html: (r, unsubscribeUrl) => built(r, unsubscribeUrl).html }
}

interface DispatchOutcome { dispatched: number; failed: number; skipped: number; reclaimed: number; continued: number }
type JobOutcome = 'dispatched' | 'failed' | 'skipped' | 'continued'

/** Reclaim reminders wedged in 'sending' — the function died after claim() but before
 *  finalize(). A job that uses the delivery ledger is RESUMED (back to 'scheduled' at its cursor)
 *  up to `retryCount` times: the ledger guarantees nobody already attempted is emailed again.
 *  A job without the ledger (claimed before RD-COMMS-P2-E) or out of resumes is moved to a
 *  terminal 'failed' — at-most-once, never re-sent. Guarded so an in-flight dispatch is never
 *  disturbed. Best-effort — a reaper failure must not block dispatch. */
async function reclaimStaleSending(nowMs: number, retryCount: number): Promise<number> {
  let reclaimed = 0
  try {
    const stale = await REMINDERS.where('status', '==', 'sending').limit(200).get()
    for (const d of stale.docs) {
      const u = (d.data() as { updatedAt?: Timestamp }).updatedAt
      const isStale = u instanceof Timestamp ? (nowMs - u.toMillis()) >= SEND_LEASE_MS : true
      if (!isStale) continue
      const ok = await adminDb.runTransaction(async txn => {
        const s = await txn.get(d.ref)
        const cur = s.data() as ReminderJob & { status?: string } | undefined
        if (!s.exists || cur?.status !== 'sending') return false
        const resumes = num(cur.resumes)
        if (cur.deliveryLedger === true && resumes < retryCount) {
          txn.update(d.ref, {
            status: 'scheduled', resumes: resumes + 1, error: 'resumed_after_interruption',
            updatedAt: FieldValue.serverTimestamp(),
          })
        } else {
          txn.update(d.ref, {
            status: 'failed', error: 'stale_sending_reclaimed',
            dispatchedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          })
        }
        return true
      })
      if (ok) reclaimed++
    }
  } catch { /* index / transient — reaper is best-effort */ }
  return reclaimed
}

/** Run one claimed job to a terminal state, or hand it back ('continued') at its cursor. */
async function runClaimed(
  id: string, data: ReminderJob, env: { settings: ReminderSettings; comm: { email: { enabled: boolean } }; emailLive: boolean; deadline: number },
): Promise<JobOutcome> {
  const counts = countsOf(data.counts)

  // RD-COMMS-P1 — a low-balance ("add funds") reminder scheduled before retirement is never sent.
  if (data.kind === 'low_wallet') {
    await finalize(id, 'skipped', { ...counts, skipped: counts.skipped + 1 }, 'retired')
    return 'skipped'
  }

  // Channel gate — only email is live; anything else (or email disabled) is skipped.
  if (data.channel !== 'email' || !env.emailLive) {
    await finalize(id, 'skipped', { ...counts, skipped: counts.skipped + 1 }, env.emailLive ? 'channel_not_live' : 'email_disabled')
    return 'skipped'
  }

  let gate: Awaited<ReturnType<typeof reminderExecutionBlock>>
  try {
    gate = await reminderExecutionBlock(id, data, env.settings, env.comm)
  } catch {
    // The current state could not be READ — nothing is sent. Defer, a bounded number of times.
    const n = num(data.guardErrors) + 1
    if (n >= MAX_GUARD_ERRORS) { await finalize(id, 'failed', counts, 'guard_unavailable'); return 'failed' }
    await release(id, { guardErrors: n })
    return 'continued'
  }
  if (gate.block) {
    await finalize(id, 'skipped', counts, gate.block)
    return 'skipped'
  }

  const { subject, html } = buildContent(data, gate.event)
  // RD-EMAIL-PROVIDER — a reminder is always about ONE event, so it leaves through that
  // event's transport. Reminders with no event resolve to the platform default.
  const provider = await resolveEventEmailProvider(data.eventId)
  const ctx: SendContext = { id, data, logicalKey: gate.logicalKey, subject, html, provider }

  if (data.audience === 'organizer') {
    await sendWave(ctx, await resolveOrganizerRecipients(data), counts)
  } else {
    // RD-ORGANIZER-04 P1-4: page confirmed attendees with a cursor (REMINDER_PAGE at a time) —
    // no cap, no full-recipient-list memory spike. The cursor is persisted after each page and on
    // a pause, so a run that stops part-way continues where it left off.
    let cursor = typeof data.cursor === 'string' && data.cursor ? data.cursor : null
    for (;;) {
      let q = adminDb.collection('registrations')
        .where('eventSlug', '==', data.eventId)
        .where('status',    '==', 'confirmed')
        .orderBy(FieldPath.documentId())
        .limit(REMINDER_PAGE)
      if (cursor) q = q.startAfter(cursor)
      const snap = await q.get()
      if (snap.empty) break

      // Eligibility NOW: the canonical admission rule excludes refunded/cancelled/pending/rejected.
      // In-page email dedupe saves sends; the ledger is what guarantees it across pages.
      const seen = new Set<string>()
      const page: Recipient[] = []
      for (const d of snap.docs) {
        const r = d.data() as Record<string, unknown>
        if (checkInBlockReason({ status: String(r.status ?? ''), paymentStatus: (r.paymentStatus as string | null | undefined) ?? null }) !== null) continue
        const email = (nested(r, 'attendee', 'email') as string) || ''
        if (!email || seen.has(email.toLowerCase())) continue
        seen.add(email.toLowerCase())
        page.push({ email, name: (nested(r, 'attendee', 'name') as string) || '', docId: d.id })
      }

      for (let i = 0; i < page.length; i += WAVE) {
        if (Date.now() > env.deadline) {
          // Out of time: hand the job back at the last fully-sent recipient.
          await release(id, { cursor: cursor ?? null, counts })
          return 'continued'
        }
        const wave = page.slice(i, i + WAVE)
        await sendWave(ctx, wave, counts)
        cursor = wave[wave.length - 1].docId ?? cursor
      }
      cursor = snap.docs[snap.docs.length - 1].id
      await REMINDERS.doc(id).update({ cursor, counts, updatedAt: FieldValue.serverTimestamp() })   // checkpoint + lease heartbeat
      if (snap.size < REMINDER_PAGE) break
    }
  }

  if (counts.recipients === 0) {
    await finalize(id, 'skipped', counts, 'no_recipients')
    return 'skipped'
  }
  if (counts.sent + counts.failed === 0) {
    // Everyone was already reminded (ledger) or has unsubscribed — nothing new to send.
    await finalize(id, 'skipped', counts, 'no_eligible_recipients')
    return 'skipped'
  }
  const status: ReminderStatus = counts.sent === 0 ? 'failed' : counts.failed > 0 ? 'partial' : 'sent'
  await finalize(id, status, counts)
  return status === 'failed' ? 'failed' : 'dispatched'
}

/** Dispatch all reminders that are due (status scheduled, sendAt ≤ now). Bounded by
 *  a wall-clock budget so a large backlog can never overrun the function timeout —
 *  unprocessed jobs stay 'scheduled' and roll to the next run. */
export async function dispatchDueReminders(limit = 50, budgetMs = DEFAULT_BUDGET_MS): Promise<DispatchOutcome> {
  const startedAt = Date.now()
  const deadline = startedAt + budgetMs
  const comm = await getCommunicationConfig()
  // RD-EMAIL-PROVIDER — batch-level health check across MANY events, so it can only ask
  // about the platform default. Each wave then resolves and sends on its own event transport.
  const emailLive = comm.email.enabled && notificationEngine.isAvailable(NotificationChannel.EMAIL)
  // Read UNCACHED, so a reminder switch turned off a moment ago is already honoured.
  const settings = await getReminderSettings({ fresh: true })

  // Un-wedge reminders stuck in 'sending' from a prior crashed run before we claim new work.
  const reclaimed = await reclaimStaleSending(startedAt, settings.retryCount)

  const snap = await REMINDERS
    .where('status', '==', 'scheduled')
    .where('sendAt', '<=', Timestamp.now())
    .orderBy('sendAt', 'asc')
    .limit(limit)
    .get()

  const outcome: DispatchOutcome = { dispatched: 0, failed: 0, skipped: 0, reclaimed, continued: 0 }

  for (const doc of snap.docs) {
    // Stop claiming new reminders once the budget is spent; the rest remain
    // 'scheduled' and are picked up on the next cron tick (no state left dangling).
    if (Date.now() > deadline) break
    const data = await claim(doc.id)
    if (!data) { outcome.skipped++; continue }   // claimed by a concurrent run / not scheduled

    try {
      outcome[await runClaimed(doc.id, data, { settings, comm, emailLive, deadline })]++
    } catch (err) {
      // A malformed job or a hard failure is recorded on THAT job and the run moves on. Never
      // re-sent automatically: the ledger already holds everyone attempted.
      await finalize(doc.id, 'failed', countsOf(data.counts), err instanceof Error ? err.message : 'dispatch_error').catch(() => {})
      outcome.failed++
    }
  }

  return outcome
}
