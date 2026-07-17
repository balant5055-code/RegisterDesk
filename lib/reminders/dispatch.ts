// Reminder dispatcher — server-only. Picks up due reminder jobs, CLAIMS each with
// a status-guarded transition (scheduled → sending) so overlapping cron runs can't
// double-send, then delivers through the EXISTING notification engine
// (NotificationType.CUSTOM_EMAIL) and logs every send to `emailLogs` — no duplicate
// communication code. Email is the live channel; the channel field is reserved for
// WhatsApp/SMS once approved reminder templates exist.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { writeEmailLog } from '@/lib/email-logs/write'
import { EMAIL_PROVIDER_NAME, fmtEmailDate } from '@/lib/email'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { APP_URL } from '@/lib/env'
import { buildReminderContent } from './templates'
import type { ReminderDocData, ReminderStatus } from './types'

const REMINDERS = adminDb.collection('scheduledReminders')
const MAX_RECIPIENTS = 2000   // per reminder dispatch (bounded per cron invocation)
const WAVE = 20               // concurrent sends per wave (mirrors broadcast delivery)
const SEND_LEASE_MS = 10 * 60 * 1000   // a 'sending' reminder older than this is presumed dead
const DEFAULT_BUDGET_MS = 45_000       // stop claiming new work before the 60s function limit

interface Recipient { email: string; name: string }

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k] }
  return cur
}

/** Claim a due reminder: scheduled → sending. Returns the data, or null if another
 *  run already claimed it (status guard = never double-send). */
async function claim(id: string): Promise<ReminderDocData | null> {
  const ref = REMINDERS.doc(id)
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) return null
    const data = snap.data() as ReminderDocData & { status: string }
    if (data.status !== 'scheduled') return null
    txn.update(ref, { status: 'sending', updatedAt: FieldValue.serverTimestamp() })
    return data
  })
}

async function finalize(id: string, status: ReminderStatus, counts: ReminderDocData['counts'], error?: string): Promise<void> {
  await REMINDERS.doc(id).set({
    status, counts,
    error: error ?? null,
    dispatchedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** Resolve the recipient list for a reminder (attendees = confirmed registrations). */
async function resolveRecipients(data: ReminderDocData): Promise<Recipient[]> {
  if (data.audience === 'organizer') {
    const snap = await adminDb.doc(`users/${data.organizerUid}`).get()
    const u = snap.exists ? (snap.data() as Record<string, unknown>) : {}
    const email = typeof u.email === 'string' ? u.email : ''
    if (!email) return []
    return [{ email, name: typeof u.name === 'string' ? u.name : (typeof u.organizationName === 'string' ? u.organizationName : '') }]
  }
  if (!data.eventId) return []
  const snap = await adminDb.collection('registrations')
    .where('eventSlug', '==', data.eventId)
    .where('status', '==', 'confirmed')
    .limit(MAX_RECIPIENTS)
    .get()
  const seen = new Set<string>()
  const out: Recipient[] = []
  for (const d of snap.docs) {
    const r = d.data() as Record<string, unknown>
    const email = (nested(r, 'attendee', 'email') as string) || ''
    if (!email || seen.has(email.toLowerCase())) continue
    seen.add(email.toLowerCase())
    out.push({ email, name: (nested(r, 'attendee', 'name') as string) || '' })
  }
  return out
}

/** Build the reminder content (subject/html) for this reminder, fetching event
 *  details for the attendee-facing templates. */
async function buildContent(data: ReminderDocData): Promise<{ subject: string; html: (r: Recipient) => string }> {
  if (data.kind === 'custom') {
    const c = buildReminderContent({ kind: 'custom', eventName: data.eventName, customSubject: data.subject ?? undefined, customMessage: data.message ?? undefined })
    return { subject: c.subject, html: () => c.html }
  }
  if (data.kind === 'low_wallet') {
    const built = (r: Recipient) => buildReminderContent({ kind: 'low_wallet', eventName: data.eventName, recipientName: r.name, eventUrl: `${APP_URL}/dashboard/wallet` })
    return { subject: built({ email: '', name: '' }).subject, html: r => built(r).html }
  }
  // Event-anchored kinds — fetch fresh event schedule/venue.
  let dateLabel: string | undefined, timeLabel: string | undefined, venueLabel: string | undefined
  if (data.eventId) {
    const ev = (await adminDb.doc(`events/${data.eventId}`).get()).data() as Record<string, unknown> | undefined
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
  const built = (r: Recipient) => buildReminderContent({
    kind: data.kind, eventName: data.eventName, recipientName: r.name,
    eventDateLabel: dateLabel, eventTimeLabel: timeLabel, venueLabel, eventUrl,
  })
  return { subject: built({ email: '', name: '' }).subject, html: r => built(r).html }
}

interface DispatchOutcome { dispatched: number; failed: number; skipped: number; reclaimed: number }

/** Reclaim reminders wedged in 'sending' — the function died after claim() but
 *  before finalize(), leaving the job stuck (and miscounted as scheduled by
 *  analytics). At-most-once by design, so we do NOT re-send (a partial fan-out
 *  must never be duplicated); instead we move the stuck job to a terminal 'failed'
 *  state so it is surfaced and no longer wedged. Guarded so an in-flight dispatch
 *  is never disturbed. Best-effort — a reaper failure must not block dispatch. */
async function reclaimStaleSending(nowMs: number): Promise<number> {
  let reclaimed = 0
  try {
    const stale = await REMINDERS.where('status', '==', 'sending').limit(200).get()
    for (const d of stale.docs) {
      const u = (d.data() as { updatedAt?: Timestamp }).updatedAt
      const isStale = u instanceof Timestamp ? (nowMs - u.toMillis()) >= SEND_LEASE_MS : true
      if (!isStale) continue
      const ok = await adminDb.runTransaction(async txn => {
        const s = await txn.get(d.ref)
        if (!s.exists || (s.data() as { status?: string }).status !== 'sending') return false
        txn.update(d.ref, {
          status: 'failed', error: 'stale_sending_reclaimed',
          dispatchedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        })
        return true
      })
      if (ok) reclaimed++
    }
  } catch { /* index / transient — reaper is best-effort */ }
  return reclaimed
}

/** Dispatch all reminders that are due (status scheduled, sendAt ≤ now). Bounded by
 *  a wall-clock budget so a large backlog can never overrun the function timeout —
 *  unprocessed jobs stay 'scheduled' (unclaimed) and roll to the next run. */
export async function dispatchDueReminders(limit = 50, budgetMs = DEFAULT_BUDGET_MS): Promise<DispatchOutcome> {
  const startedAt = Date.now()
  const comm = await getCommunicationConfig()
  const emailLive = comm.email.enabled && notificationEngine.isAvailable(NotificationChannel.EMAIL)

  // Un-wedge any reminders stuck in 'sending' from a prior crashed run before we
  // claim new work (at-most-once: surfaced as failed, never re-sent).
  const reclaimed = await reclaimStaleSending(startedAt)

  const snap = await REMINDERS
    .where('status', '==', 'scheduled')
    .where('sendAt', '<=', Timestamp.now())
    .orderBy('sendAt', 'asc')
    .limit(limit)
    .get()

  const outcome: DispatchOutcome = { dispatched: 0, failed: 0, skipped: 0, reclaimed }

  for (const doc of snap.docs) {
    // Stop claiming new reminders once the budget is spent; the rest remain
    // 'scheduled' and are picked up on the next cron tick (no state left dangling).
    if (Date.now() - startedAt > budgetMs) break
    const data = await claim(doc.id)
    if (!data) { outcome.skipped++; continue }   // claimed by a concurrent run / not scheduled

    // Channel gate — only email is live; anything else (or email disabled) is skipped.
    if (data.channel !== 'email' || !emailLive) {
      await finalize(doc.id, 'skipped', { ...data.counts, skipped: (data.counts.skipped ?? 0) + 1 }, emailLive ? 'channel_not_live' : 'email_disabled')
      outcome.skipped++
      continue
    }

    try {
      const recipients = await resolveRecipients(data)
      if (recipients.length === 0) {
        await finalize(doc.id, 'skipped', { recipients: 0, sent: 0, failed: 0, skipped: 0 }, 'no_recipients')
        outcome.skipped++
        continue
      }

      const { subject, html } = await buildContent(data)
      let sent = 0, failed = 0

      for (let i = 0; i < recipients.length; i += WAVE) {
        const wave = recipients.slice(i, i + WAVE)
        const results = await Promise.all(wave.map(async r => {
          try {
            const result = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: r.email, subject, html: html(r) })
            void writeEmailLog({
              organizerUid: data.organizerUid, eventId: data.eventId ?? '', eventSlug: data.eventId ?? '',
              eventName: data.eventName, templateKey: 'event_reminder',
              recipientEmail: r.email, recipientName: r.name, subject,
              status: result.success ? 'sent' : 'failed', provider: EMAIL_PROVIDER_NAME, channel: 'email',
              providerMessageId: result.messageId, error: result.success ? undefined : (result.errorDetail ?? result.error),
            })
            return result.success
          } catch {
            return false
          }
        }))
        for (const ok of results) { if (ok) sent++; else failed++ }
      }

      const status: ReminderStatus = sent === 0 ? 'failed' : failed > 0 ? 'partial' : 'sent'
      await finalize(doc.id, status, { recipients: recipients.length, sent, failed, skipped: 0 })
      if (status === 'failed') outcome.failed++; else outcome.dispatched++
    } catch (err) {
      // Single-attempt by design: a claimed fan-out is never re-sent (no duplicate
      // emails). A hard failure is recorded, not retried.
      await finalize(doc.id, 'failed', { ...data.counts }, err instanceof Error ? err.message : 'dispatch_error')
      outcome.failed++
    }
  }

  return outcome
}
