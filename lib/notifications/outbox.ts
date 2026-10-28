// lib/notifications/outbox.ts
// RD-NOTIFY-01 — the durable notification outbox. Server-only.
//
//   notificationOutbox/{id}  { audience, kind, subject, heading, intro, facts[], path, ctaLabel,
//                              status: pending|sending|sent|unconfirmed|failed, attempts, nextAttemptAt,
//                              delivered: { [recipientKey]: true },
//                              skipped: { [recipientKey]: 'suppressed' | 'unconfirmed' }, lastError, … }
//
// WHY: important organizer actions (an event sent for review, a payout profile change, a refund /
// carry-forward request, a payout request) and the Super Admin decisions on them must reach the
// right people, and a failed email must not silently disappear. The existing admin alert
// (servicePurchase) sends once and never retries; this generalises it:
//
//   • STAGED IN THE SAME TRANSACTION / BATCH as the action it announces (stageOutboxMessage) — so
//     an alert exists if and only if the action persisted. Never an email about a failed write.
//   • The in-app item (the Super Admin feed `adminNotifications`, or the organizer's inbox) is
//     staged in that same commit, under the same deterministic id.
//   • Email is delivered right after the response (scheduleOutboxDelivery → after()) and, if that
//     fails or the process dies, re-attempted by the ops-alerts cron (drainOutbox, every 10 min)
//     with backoff, up to OUTBOX_MAX_ATTEMPTS. Then status 'failed' + lastError: observable,
//     never dropped silently.
//   • Per-recipient delivery is recorded, so a retry never re-sends to someone already reached.
//     (At-least-once per recipient: a crash between a provider accept and that record can repeat
//     ONE email — never a whole batch.)
//   • The lease carries a token (leaseId). Each recipient is claimed in its own transaction that
//     re-checks the token and marks the recipient `inflight` before the provider is called; the
//     outcome clears the mark. A driver that lost its lease (ran past LEASE_MS while a cron took
//     over) stops at its next claim instead of re-sending everything, and a takeover settles any
//     recipient left in flight as 'unconfirmed' rather than sending it again (the provider may
//     already have accepted it). Recipients are de-duplicated by mailbox, not spelling.
//   • 'sent' means EVERY recipient's provider accepted the email. A recipient the provider
//     suppressed (a deliberate non-send), or whose send had no definite answer (deliveryUnknown —
//     it may already have gone out), is recorded in `skipped` and never re-sent (re-sending an
//     unknown outcome is how one person gets the same email twice — see the engine). If any
//     recipient ends that way the message ends 'unconfirmed' with lastError naming them: terminal,
//     visible, and never reported as delivered.
//
// Ids MUST be unique per occurrence (e.g. the request id, the history record id, the submit time):
// `create` inside a transaction would otherwise fail the caller's own write. For triggers that can
// legitimately re-run (webhooks), use enqueueOutboxMessage after the commit — it ignores a repeat.
//
// Content rule: identities, statuses and links only. Never bank/account numbers, PAN, IFSC,
// credentials or attendee personal data.

import { randomUUID } from 'crypto'
import { FieldValue, Timestamp, type Transaction, type WriteBatch } from 'firebase-admin/firestore'
import { after } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { emailShell, escHtml } from '@/lib/email/templates/base'
import { emailUrl } from '@/lib/email/appUrl'
import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'
import { superAdminRecipients } from './superAdminRecipients'
import { uniqueMailboxes, canonicalMailbox } from './mailbox'
import { ADMIN_NOTIFICATIONS, type AdminNotificationKind } from './adminInbox'
import { prepareNotification } from './inbox/write'
import type { NotificationCategory, NotificationSeverity } from './inbox/types'

export const NOTIFICATION_OUTBOX = 'notificationOutbox'
export const OUTBOX_MAX_ATTEMPTS = 8
const LEASE_MS = 2 * 60_000
/** Minutes until the next attempt after the n-th failure (n ≥ 1). */
const BACKOFF_MIN = [1, 5, 15, 60, 180, 360, 720]
const ID = /^[A-Za-z0-9_:.-]{1,200}$/

export type OutboxAudience =
  | { kind: 'super_admins' }
  | { kind: 'organizer'; organizerUid: string }

export interface OutboxFact { label: string; value: string }

export interface OutboxMessageInput {
  /** Deterministic, unique per occurrence. Also the in-app item's id. */
  id:        string
  audience:  OutboxAudience
  subject:   string
  heading:   string
  intro:     string
  facts:     OutboxFact[]
  /** Dashboard path (made absolute for email; used as-is in-app). */
  path:      string
  ctaLabel:  string
  /** Super Admin feed kind (audience super_admins). */
  adminKind?: AdminNotificationKind
  /** Organizer inbox placement (audience organizer). */
  inbox?: { category: NotificationCategory; type: string; severity?: NotificationSeverity; actionRequired?: boolean; eventId?: string | null; eventName?: string | null }
  /** Stored on the admin feed item for filtering (ids only — never sensitive values). */
  metadata?: Record<string, string | number | null>
}

const ref = (id: string) => adminDb.collection(NOTIFICATION_OUTBOX).doc(id)

function outboxDoc(m: OutboxMessageInput): Record<string, unknown> {
  return {
    audience: m.audience, subject: m.subject.slice(0, 200), heading: m.heading.slice(0, 200), intro: m.intro.slice(0, 1000),
    facts: m.facts.slice(0, 12).map(f => ({ label: f.label.slice(0, 80), value: f.value.slice(0, 300) })),
    path: m.path, ctaLabel: m.ctaLabel.slice(0, 60),
    status: 'pending', attempts: 0, delivered: {}, skipped: {}, lastError: null,
    nextAttemptAt: Timestamp.now(), createdAt: FieldValue.serverTimestamp(),
  }
}

function inAppBody(m: OutboxMessageInput): string {
  return [m.intro, ...m.facts.map(f => `${f.label}: ${f.value}`)].join(' · ').slice(0, 1000)
}

/**
 * Stages the outbox message AND its in-app item into the caller's transaction or batch. The id
 * must be unique per occurrence (see header). Throws on an invalid id (a programming error).
 */
export function stageOutboxMessage(w: Transaction | WriteBatch, m: OutboxMessageInput): void {
  if (!ID.test(m.id)) throw new Error('invalid outbox id')
  ;(w as WriteBatch).create(ref(m.id), outboxDoc(m))
  if (m.audience.kind === 'super_admins') {
    ;(w as WriteBatch).create(adminDb.collection(ADMIN_NOTIFICATIONS).doc(m.id), {
      kind: m.adminKind ?? 'service_purchase', title: m.subject.slice(0, 200), body: inAppBody(m), href: m.path,
      metadata: m.metadata ?? {}, createdAt: FieldValue.serverTimestamp(), readBy: {},
    })
  } else if (m.inbox) {
    const p = prepareNotification({
      workspaceUid: m.audience.organizerUid, dedupeId: m.id, category: m.inbox.category, type: m.inbox.type,
      title: m.subject, body: inAppBody(m), severity: m.inbox.severity, actionRequired: m.inbox.actionRequired,
      link: m.path, eventId: m.inbox.eventId ?? null, eventName: m.inbox.eventName ?? null,
    })
    if (p) (w as WriteBatch).set(p.ref, p.data)
  }
}

/**
 * Outside a transaction (after a commit whose trigger may re-run, e.g. a webhook): creates the
 * message + in-app item once; a repeat of the same id is a no-op. Never throws.
 */
export async function enqueueOutboxMessage(m: OutboxMessageInput): Promise<'queued' | 'duplicate' | 'failed'> {
  try {
    const batch = adminDb.batch()
    stageOutboxMessage(batch, m)
    await batch.commit()
    return 'queued'
  } catch (err) {
    if ((err as { code?: number }).code === 6) return 'duplicate'      // ALREADY_EXISTS
    console.error('[notification-outbox] enqueue failed', { id: m.id, err })
    return 'failed'
  }
}

/** A recipient address as a Firestore-safe map key. (The LEGACY delivery key — see mailboxKey.) */
export function recipientKey(email: string): string {
  return email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 150)
}

/**
 * RD-NOTIFY-DEDUP-02 — the delivery key: the recipient's canonical MAILBOX (lib/notifications/mailbox),
 * the same identity the recipient list is de-duplicated by. Keying delivery by the raw address let a
 * retry that picked a different spelling of one mailbox (two Super Admin accounts sharing an inbox,
 * resolved in a different order) miss "already delivered" and send that inbox a second copy.
 */
export function mailboxKey(email: string): string {
  return recipientKey(canonicalMailbox(email))
}

/**
 * Has this recipient's mailbox already been settled on this message? Checks the mailbox key AND the
 * legacy raw-address key, so records written before RD-NOTIFY-DEDUP-02 still count — no migration.
 */
function settledFor(s: { delivered?: Record<string, boolean>; skipped?: Record<string, unknown> }, email: string): { delivered: boolean; skipped: unknown } {
  const keys = [mailboxKey(email), recipientKey(email)]
  return {
    delivered: keys.some(k => s.delivered?.[k] === true),
    skipped:   keys.map(k => s.skipped?.[k]).find(v => v !== undefined),
  }
}

/** Pure: the email body for a message. Every value is escaped. */
export function renderOutboxEmail(d: { subject: string; heading: string; intro: string; facts: OutboxFact[]; url: string; ctaLabel: string }): string {
  const rows = d.facts.map(f =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escHtml(f.label)}</td>` +
    `<td style="padding:4px 0;color:#111827">${escHtml(f.value)}</td></tr>`).join('')
  const body =
    `<h2 style="margin:0 0 8px;font-size:18px">${escHtml(d.heading)}</h2>` +
    `<p style="margin:0 0 16px">${escHtml(d.intro)}</p>` +
    (rows ? `<table style="border-collapse:collapse;font-size:14px;margin:0 0 20px">${rows}</table>` : '') +
    `<p style="margin:0"><a href="${escHtml(d.url)}" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${escHtml(d.ctaLabel)}</a></p>`
  return emailShell(d.subject, body)
}

/** Recipients, one per MAILBOX (two spellings of one Gmail inbox are one recipient). */
async function recipientsFor(a: OutboxAudience): Promise<string[]> {
  if (a.kind === 'super_admins') return uniqueMailboxes(await superAdminRecipients())
  const id = await resolveOrganizerEmailIdentity(a.organizerUid)
  return id.email ? [id.email] : []
}

function absolute(path: string): string {
  try { return emailUrl(path) } catch { return path }
}

export type DeliveryOutcome = 'sent' | 'unconfirmed' | 'retry' | 'failed' | 'busy' | 'done' | 'missing'
type SkipReason = 'suppressed' | 'unconfirmed'

/** Delivers one message (claim → send to each not-yet-reached recipient → record). Never throws. */
export async function deliverOutboxMessage(id: string, now = Date.now()): Promise<DeliveryOutcome> {
  try {
    const r = ref(id)
    const leaseId = randomUUID()
    // 1. Claim with a lease, so two drivers (after() + cron) never send concurrently. The lease
    //    carries a token: every later step checks it, so a driver that lost the lease (it ran past
    //    LEASE_MS and someone else took over) stops instead of sending the same emails again.
    const claimed = await adminDb.runTransaction(async txn => {
      const s = await txn.get(r)
      if (!s.exists) return 'missing' as const
      const d = s.data() as { status?: string; leaseUntil?: Timestamp; leaseId?: string; inflight?: Record<string, string> }
      if (d.status === 'sent' || d.status === 'unconfirmed' || d.status === 'failed') return 'done' as const
      if (d.status === 'sending' && d.leaseUntil && d.leaseUntil.toMillis() > now) return 'busy' as const
      const lease = Timestamp.fromMillis(now + LEASE_MS)
      // A recipient still marked in flight belongs to a driver that died or lost its lease mid-send:
      // the provider may have accepted that email, so it is settled as 'unconfirmed', never re-sent.
      const orphaned = Object.keys(d.inflight ?? {})
      // nextAttemptAt = lease end: a driver that dies mid-send is picked up again by the cron.
      txn.update(r, {
        status: 'sending', leaseUntil: lease, leaseId, nextAttemptAt: lease,
        ...Object.fromEntries(orphaned.flatMap(k => [[`skipped.${k}`, 'unconfirmed'], [`inflight.${k}`, FieldValue.delete()]])),
      })
      return 'claimed' as const
    })
    if (claimed !== 'claimed') return claimed

    type Doc = {
      audience: OutboxAudience; subject: string; heading: string; intro: string; facts: OutboxFact[]
      path: string; ctaLabel: string; attempts?: number; delivered?: Record<string, boolean>
      skipped?: Record<string, SkipReason>; leaseId?: string
    }
    const d = (await r.get()).data() as Doc
    const errors: string[] = []
    let to: string[] = []
    if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) errors.push('email channel disabled')
    else {
      to = await recipientsFor(d.audience).catch(() => [])
      if (to.length === 0) errors.push('no recipient email address')
    }
    const html = renderOutboxEmail({ ...d, url: absolute(d.path) })
    for (const email of to) {
      const key = mailboxKey(email)
      // 2. Per-recipient claim: still our lease, not already settled → mark in flight, extend lease.
      const go = await adminDb.runTransaction(async txn => {
        const s = (await txn.get(r)).data() as Doc
        if (s.leaseId !== leaseId) return 'lost' as const
        const done = settledFor(s, email)
        if (done.delivered || done.skipped !== undefined) return 'settled' as const
        txn.update(r, { [`inflight.${key}`]: leaseId, leaseUntil: Timestamp.fromMillis(Math.max(now, Date.now()) + LEASE_MS) })
        return 'send' as const
      })
      if (go === 'lost') return 'busy'
      if (go === 'settled') continue
      // 3. Send OUTSIDE any transaction; record the outcome and clear the in-flight mark together.
      let outcome: Record<string, unknown>
      try {
        const res = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to: email, subject: d.subject, html })
        if (res && res.success === false) {
          const reason: SkipReason | null = res.suppressed ? 'suppressed' : res.deliveryUnknown ? 'unconfirmed' : null
          if (reason) outcome = { [`skipped.${key}`]: reason }
          else { errors.push(`${email}: ${res.error ?? 'not sent'}`); outcome = {} }          // definite rejection: retry later
        } else outcome = { [`delivered.${key}`]: true }
      } catch (e) {
        errors.push(`${email}: ${e instanceof Error ? e.message : 'send failed'}`); outcome = {}
      }
      await r.update({ ...outcome, [`inflight.${key}`]: FieldValue.delete() })
    }

    // 4. Settle — only while we still hold the lease (a takeover driver settles otherwise).
    return await adminDb.runTransaction(async txn => {
      const s = (await txn.get(r)).data() as Doc
      if (s.leaseId !== leaseId) return 'busy' as const
      if (errors.length === 0) {
        // Only an all-accepted message is 'sent'; a suppressed / no-definite-answer recipient makes it
        // 'unconfirmed' (terminal — never re-sent, never reported as delivered).
        const unsettled = to.filter(e => { const st = settledFor(s, e); return !st.delivered && st.skipped !== undefined })
        if (unsettled.length > 0) {
          txn.update(r, {
            status: 'unconfirmed', settledAt: FieldValue.serverTimestamp(), leaseUntil: FieldValue.delete(), leaseId: FieldValue.delete(), nextAttemptAt: FieldValue.delete(),
            lastError: unsettled.map(e => `${e}: ${settledFor(s, e).skipped === 'suppressed' ? 'suppressed by the email provider (not sent)' : 'no definite answer from the email provider (not re-sent)'}`).join(' | ').slice(0, 1000),
          })
          console.warn('[notification-outbox] not confirmed', { id, recipients: unsettled.length })
          return 'unconfirmed' as const
        }
        txn.update(r, { status: 'sent', sentAt: FieldValue.serverTimestamp(), lastError: null, leaseUntil: FieldValue.delete(), leaseId: FieldValue.delete(), nextAttemptAt: FieldValue.delete() })
        return 'sent' as const
      }
      const attempts = (s.attempts ?? 0) + 1
      const final = attempts >= OUTBOX_MAX_ATTEMPTS
      txn.update(r, {
        attempts, lastError: errors.join(' | ').slice(0, 1000), leaseUntil: FieldValue.delete(), leaseId: FieldValue.delete(),
        status: final ? 'failed' : 'pending',
        nextAttemptAt: final ? FieldValue.delete() : Timestamp.fromMillis(now + BACKOFF_MIN[Math.min(attempts, BACKOFF_MIN.length) - 1] * 60_000),
        ...(final ? { failedAt: FieldValue.serverTimestamp() } : {}),
      })
      if (final) console.error('[notification-outbox] gave up', { id, errors })
      return final ? 'failed' as const : 'retry' as const
    })
  } catch (err) {
    console.error('[notification-outbox] delivery error', { id, err })
    return 'retry'
  }
}

/** Cron: delivers every message that is due (pending, or a lapsed lease). Bounded per run. */
export async function drainOutbox(limit = 50, now = Date.now()): Promise<{ due: number; sent: number; unconfirmed: number; retry: number; failed: number }> {
  const snap = await adminDb.collection(NOTIFICATION_OUTBOX)
    .where('nextAttemptAt', '<=', Timestamp.fromMillis(now)).limit(limit).get()
  const out = { due: snap.size, sent: 0, unconfirmed: 0, retry: 0, failed: 0 }
  for (const doc of snap.docs) {
    const o = await deliverOutboxMessage(doc.id, now)
    if (o === 'sent') out.sent++
    else if (o === 'unconfirmed') out.unconfirmed++
    else if (o === 'failed') out.failed++
    else if (o === 'retry') out.retry++
  }
  return out
}

/** Right after the response (Next's after()); outside a request scope, fire-and-forget. */
export function scheduleOutboxDelivery(...ids: string[]): void {
  const run = async () => { for (const id of ids) await deliverOutboxMessage(id) }
  try { after(run) } catch { void run() }
}

/** Shared: a timestamp for email facts, in the platform's zone. */
export function istNow(d = new Date()): string {
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST'
}
