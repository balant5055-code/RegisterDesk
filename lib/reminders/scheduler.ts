// Reminder scheduler (materializer) — server-only. Scans live events and CREATES due
// reminder jobs in `scheduledReminders` with DETERMINISTIC ids, so overlapping cron runs
// never duplicate a reminder (create-if-absent inside a transaction — the same idempotency
// idiom broadcasts / wallet charges use). It sends nothing; the dispatcher does that when
// jobs fall due.
//
// RD-COMMS-P2-E:
//   • times are computed in the EVENT's timezone (anchor.ts), not a hard-coded IST offset;
//   • the job id carries the anchor instant, so a moved event gets a fresh job, and the
//     dispatcher refuses the old one (executionGuard.ts) — never two for one anchor: a job in
//     the pre-P2-E id format that matches the same anchor blocks its successor;
//   • every live event is reached — events are paged by id with a persisted cursor, instead of
//     the first 500 only — and `registration_closed` events (still upcoming) are included;
//   • one malformed event or offset is skipped on its own; it can no longer stop the run.

import { FieldValue, FieldPath, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { getReminderSettings, isEventRemindersEnabled, type ReminderSettings } from './config'
import { AUTO_REMINDER_KINDS, KIND_AUDIENCE, type ReminderKind } from './types'
import {
  reminderAnchor, reminderTimezone, isValidOffsetHours, autoReminderId, legacyAutoReminderId,
  legacySendAtMatches, REMINDER_GRACE_MS,
} from './anchor'

const REMINDERS = adminDb.collection('scheduledReminders')
const STATE_DOC = adminDb.doc('system/reminderScheduler')

const EVENT_PAGE = 200
const LIVE_STATES = ['published', 'registration_closed']
const HORIZON_MS = 50 * 60 * 60 * 1000     // only materialize reminders due within ~2 days
const DEFAULT_BUDGET_MS = 20_000           // leave the rest of the cron window to dispatch

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k] }
  return cur
}

interface Materialized { created: number; scannedEvents: number; scannedOrganizers: number; invalid: number }

/**
 * Create the job only if neither its id nor a legacy job for the SAME anchor exists. A job the
 * dispatcher skipped as `event_rescheduled` is revived when the event moves back to that anchor
 * (it never sent; the delivery ledger still stops a repeat to anyone who did get it).
 */
async function createIfAbsent(
  id: string, legacyId: string, anchorMs: number, offsetHours: number, data: Record<string, unknown>,
): Promise<boolean> {
  const ref = REMINDERS.doc(id)
  const legacyRef = REMINDERS.doc(legacyId)
  return adminDb.runTransaction(async txn => {
    const [snap, legacy] = await Promise.all([txn.get(ref), txn.get(legacyRef)])
    if (legacy.exists) {
      const sendAt = (legacy.data() as { sendAt?: unknown }).sendAt
      if (sendAt instanceof Timestamp && legacySendAtMatches(sendAt.toMillis(), anchorMs, offsetHours)) return false
    }
    if (snap.exists) {
      const cur = snap.data() as { status?: unknown; error?: unknown }
      if (cur.status !== 'skipped' || cur.error !== 'event_rescheduled') return false
      txn.update(ref, { status: 'scheduled', error: null, sendAt: data.sendAt, updatedAt: FieldValue.serverTimestamp() })
      return true
    }
    txn.set(ref, { ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return true
  })
}

/** The due auto reminders of one event. Returns [created, invalid]. Never throws for one bad kind. */
async function materializeEvent(
  eventId: string, ev: Record<string, unknown>, settings: ReminderSettings, now: number,
): Promise<[number, number]> {
  const organizerUid = typeof ev.uid === 'string' ? ev.uid : (typeof ev.organizerUid === 'string' ? ev.organizerUid : '')
  if (!organizerUid) return [0, 0]
  const eventName = (nested(ev, 'eventDetails', 'info', 'name') as string) || eventId

  const due: { kind: Exclude<ReminderKind, 'custom'>; anchor: number; sendAt: number; offset: number }[] = []
  let invalid = 0
  for (const kind of AUTO_REMINDER_KINDS) {
    if (kind === 'low_wallet') continue         // retired (RD-COMMS-P1)
    if (!settings.kinds[kind]) continue
    const offset = settings.offsetHours[kind]
    if (!isValidOffsetHours(offset)) { invalid++; continue }   // defensive; config already validates
    const anchor = reminderAnchor(kind, ev.eventDetails, ev.pricing)
    if (anchor === null || anchor < now) continue   // no anchor / malformed / already passed
    const sendAt = anchor - offset * 60 * 60 * 1000
    if (!Number.isFinite(sendAt) || sendAt < now - REMINDER_GRACE_MS || sendAt > now + HORIZON_MS) continue
    due.push({ kind, anchor, sendAt, offset })
  }
  if (due.length === 0) return [0, invalid]

  // Organizer opt-out for this event (read only when something is actually due).
  if (!(await isEventRemindersEnabled(eventId))) return [0, invalid]

  let created = 0
  const timezone = reminderTimezone(ev.eventDetails)
  for (const d of due) {
    try {
      const ok = await createIfAbsent(autoReminderId(eventId, d.kind, d.anchor), legacyAutoReminderId(eventId, d.kind), d.anchor, d.offset, {
        eventId, eventName, organizerUid, kind: d.kind, audience: KIND_AUDIENCE[d.kind],
        channel: 'email', status: 'scheduled', source: 'auto',
        subject: null, message: null,
        counts: { recipients: 0, sent: 0, failed: 0, skipped: 0 }, costPaise: 0,
        createdBy: 'system', error: null,
        anchorMs: d.anchor, timezone,
        sendAt: Timestamp.fromMillis(Math.max(d.sendAt, now)),
      })
      if (ok) created++
    } catch (err) {
      invalid++
      console.error('[reminders] materialize failed', { eventId, kind: d.kind, err: err instanceof Error ? err.message : err })
    }
  }
  return [created, invalid]
}

/** Scan live events (a page at a time, resuming where the last run stopped) and create the
 *  reminder jobs that are coming due. Bounded by `budgetMs`. */
export async function materializeReminders(budgetMs = DEFAULT_BUDGET_MS): Promise<Materialized> {
  const settings = await getReminderSettings()
  if (!settings.enabled) return { created: 0, scannedEvents: 0, scannedOrganizers: 0, invalid: 0 }

  const startedAt = Date.now()
  const now = startedAt
  const stored = (await STATE_DOC.get().catch(() => null))?.data()?.cursor
  let cursor: string | null = typeof stored === 'string' && stored ? stored : null

  let created = 0, invalid = 0, scannedEvents = 0
  const organizerUids = new Set<string>()

  for (;;) {
    let q = adminDb.collection('events')
      .where('lifecycleStatus', 'in', LIVE_STATES)
      .orderBy(FieldPath.documentId())
      .limit(EVENT_PAGE)
    if (cursor) q = q.startAfter(cursor)
    const snap = await q.get()

    for (const doc of snap.docs) {
      const ev = doc.data() as Record<string, unknown>
      if (typeof ev.uid === 'string') organizerUids.add(ev.uid)
      try {
        const [c, bad] = await materializeEvent(doc.id, ev, settings, now)
        created += c; invalid += bad
      } catch (err) {
        invalid++
        console.error('[reminders] event skipped', { eventId: doc.id, err: err instanceof Error ? err.message : err })
      }
    }
    scannedEvents += snap.size

    if (snap.size < EVENT_PAGE) { cursor = null; break }          // full pass done; next run restarts
    cursor = snap.docs[snap.docs.length - 1].id
    if (Date.now() - startedAt > budgetMs) break                   // resume from here next run
  }

  await STATE_DOC.set({ cursor, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
  return { created, scannedEvents, scannedOrganizers: organizerUids.size, invalid }
}
