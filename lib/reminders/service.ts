// Reminder query/command service — server-only. Backs the organizer + admin
// reminder APIs (list history, create custom, cancel, analytics). Writes go to the
// same `scheduledReminders` collection the cron dispatches from.

import { createHash } from 'node:crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  REMINDER_KIND_LABELS, reminderReasonLabel,
  type ReminderDocData, type ReminderRow, type ReminderAnalytics,
  type ReminderAudience,
} from './types'

const REMINDERS = adminDb.collection('scheduledReminders')

export class ReminderError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function toRow(id: string, d: Record<string, unknown>): ReminderRow {
  const data = d as unknown as ReminderDocData
  const counts = (d.counts as ReminderDocData['counts']) ?? { recipients: 0, sent: 0, failed: 0, skipped: 0 }
  return {
    id,
    eventId:      data.eventId ?? null,
    eventName:    data.eventName ?? '',
    kind:         data.kind,
    kindLabel:    REMINDER_KIND_LABELS[data.kind] ?? data.kind,
    audience:     data.audience,
    channel:      data.channel,
    status:       data.status,
    source:       data.source,
    subject:      data.subject ?? null,
    sendAt:       tsToISO(d.sendAt),
    counts,
    costPaise:    typeof d.costPaise === 'number' ? d.costPaise : 0,
    createdAt:    tsToISO(d.createdAt),
    dispatchedAt: tsToISO(d.dispatchedAt),
    // RD-COMMS-P2-F — explained in plain words; the raw `error` (a code, or an exception message)
    // never leaves the server.
    reasonLabel:  reminderReasonLabel(data.status, d.error),
    continuing:   data.status === 'scheduled' && (counts.recipients ?? 0) > 0,
    resumed:      typeof d.resumes === 'number' && d.resumes > 0,
  }
}

function analyticsFrom(rows: ReminderRow[]): ReminderAnalytics {
  const a: ReminderAnalytics = { scheduled: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0, recipients: 0, costPaise: 0 }
  for (const r of rows) {
    if (r.status === 'scheduled' || r.status === 'sending') a.scheduled++
    else if (r.status === 'sent' || r.status === 'partial') a.sent++
    else if (r.status === 'failed') a.failed++
    else if (r.status === 'skipped') a.skipped++
    else if (r.status === 'cancelled') a.cancelled++
    a.recipients += r.counts.recipients
    a.costPaise  += r.costPaise
  }
  return a
}

/** Recent reminders for one workspace (no composite index needed — sorted in-memory).
 *  RD-COMMS-P2-F — `eventSlug` narrows it to ONE event (two equality filters, still index-free);
 *  the organizerUid filter keeps another workspace's event matching nothing. */
export async function listRemindersForOrganizer(organizerUid: string, opts: { eventSlug?: string } = {}): Promise<{ items: ReminderRow[]; analytics: ReminderAnalytics }> {
  let q = REMINDERS.where('organizerUid', '==', organizerUid)
  if (opts.eventSlug) q = q.where('eventId', '==', opts.eventSlug)
  const snap = await q.limit(300).get()
  const items = snap.docs.map(d => toRow(d.id, d.data())).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
  return { items, analytics: analyticsFrom(items) }
}

/** Admin: all reminders, cursor-paginated, newest first, optional status filter. */
export async function listRemindersForAdmin(opts: { pageSize: number; cursor?: string | null; status?: string }): Promise<{ items: ReminderRow[]; nextCursor: string | null; analytics: ReminderAnalytics }> {
  const pageSize = Math.min(Math.max(opts.pageSize, 1), 100)
  let q = REMINDERS.orderBy('createdAt', 'desc').limit(pageSize + 1)
  if (opts.cursor) {
    const cur = await REMINDERS.doc(opts.cursor).get()
    if (cur.exists) q = q.startAfter(cur)
  }
  const snap = await q.get()
  const hasMore = snap.docs.length > pageSize
  const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs
  let items = pageDocs.map(d => toRow(d.id, d.data()))
  const status = (opts.status ?? '').trim()
  if (status) items = items.filter(r => r.status === status)
  return { items, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null, analytics: analyticsFrom(items) }
}

/** Create an organizer-authored custom reminder. Server-validated + ownership-checked. */
export async function createCustomReminder(input: {
  organizerUid: string
  audience:     ReminderAudience
  eventId:      string | null
  subject:      string
  message:      string
  sendAtMs:     number
}): Promise<string> {
  const subject = input.subject.trim()
  const message = input.message.trim()
  if (!subject) throw new ReminderError('Subject is required')
  if (!message) throw new ReminderError('Message is required')
  if (!Number.isFinite(input.sendAtMs)) throw new ReminderError('A valid send time is required')

  let eventName = 'Reminder'
  if (input.audience === 'attendees') {
    if (!input.eventId) throw new ReminderError('An event is required for attendee reminders')
    const ev = await adminDb.doc(`events/${input.eventId}`).get()
    if (!ev.exists) throw new ReminderError('Event not found', 404)
    const d = ev.data() as Record<string, unknown>
    const owner = typeof d.uid === 'string' ? d.uid : (typeof d.organizerUid === 'string' ? d.organizerUid : '')
    if (owner !== input.organizerUid) throw new ReminderError('You do not own this event', 403)
    eventName = (((d.eventDetails as Record<string, unknown> | undefined)?.info as Record<string, unknown> | undefined)?.name as string) || input.eventId
  }

  const sendAtMs = Math.max(input.sendAtMs, Date.now())
  // RD-COMMS-P2-E — a DETERMINISTIC id: the same organizer submitting the same reminder for the
  // same minute (a double click, a retried request) gets the one job, not two. Anything that
  // differs — subject, message, audience, event or time — is a separate reminder.
  const fingerprint = [input.organizerUid, input.audience, input.eventId ?? '', subject, message, Math.floor(input.sendAtMs / 60_000)].join('|')
  const ref = REMINDERS.doc(`crem_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 40)}`)
  const data: ReminderDocData & { sendAt: Timestamp } = {
    eventId:      input.audience === 'attendees' ? input.eventId : null,
    eventName,
    organizerUid: input.organizerUid,
    kind:         'custom',
    audience:     input.audience,
    channel:      'email',
    status:       'scheduled',
    source:       'custom',
    subject,
    message,
    counts:       { recipients: 0, sent: 0, failed: 0, skipped: 0 },
    costPaise:    0,
    createdBy:    input.organizerUid,
    error:        null,
    sendAt:       Timestamp.fromMillis(sendAtMs),
  }
  try {
    await ref.create({ ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code !== 6 && !/already exists/i.test(String((err as Error)?.message))) throw err
    // Already created by an identical request — idempotent success, unless that one was cancelled.
    const existing = (await ref.get()).data() as { status?: unknown } | undefined
    if (existing?.status === 'cancelled') {
      throw new ReminderError('An identical reminder for this time was cancelled. Change the time or the message to schedule it again.', 409)
    }
  }
  return ref.id
}

/** Cancel a scheduled reminder. Organizer callers may only cancel their own. */
export async function cancelReminder(id: string, organizerUid?: string): Promise<void> {
  const ref = REMINDERS.doc(id)
  await adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    if (!snap.exists) throw new ReminderError('Reminder not found', 404)
    const d = snap.data() as ReminderDocData & { status: string }
    if (organizerUid && d.organizerUid !== organizerUid) throw new ReminderError('Forbidden', 403)
    if (d.status !== 'scheduled') throw new ReminderError(`Cannot cancel a ${d.status} reminder`, 409)
    txn.update(ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
  })
}
