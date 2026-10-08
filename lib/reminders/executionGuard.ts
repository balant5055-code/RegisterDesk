// RD-COMMS-P2-E — the EXECUTION-TIME gate of a reminder. Server-only.
//
// A reminder is created up to ~2 days (auto) or any time (custom) before it sends. Everything it
// was created under can change in between, so the dispatcher re-reads the CURRENT state here,
// immediately before sending, for auto AND custom reminders alike:
//
//   reminder    the job itself is well-formed (organizer, kind, audience; an event for attendees)
//   settings    the global reminder switch; for auto kinds, that kind's switch
//   organizer   isModerated — the suspension/ban seam (RD-COMMS-P2-B uses the same)
//   email       communication.email.enabled — the platform email kill switch
//   event       exists, belongs to the organizer, not taken down / cancelled / draft / pending
//               review / changes requested / unpublished / archived (eventExecutionBlock, shared
//               with broadcasts)
//   opt-out     for auto kinds, the organizer's per-event reminder preference
//   schedule    for event-anchored auto kinds, the anchor re-derived from the CURRENT event date,
//               time and timezone must be the one the job was built for — a moved event never
//               gets a reminder computed from its old date
//
// A block is terminal for the job ('skipped' + this reason); nothing is retried. Recipient
// eligibility (refunds, cancellations, unsubscribes) is checked per recipient by the dispatcher.
// Email is free: nothing here reads or writes any balance or allowance.

import { adminDb } from '@/lib/firebase/admin'
import { isModerated } from '@/lib/admin/organizerStatus'
import { eventExecutionBlock } from '@/lib/broadcasts/executionGuard'

import type { ReminderSettings } from './config'
import { REMINDER_KINDS, type ReminderDocData, type ReminderKind } from './types'
import { reminderAnchor, isEventAnchoredKind, legacySendAtMatches } from './anchor'

export type ReminderBlockReason =
  | 'invalid_reminder' | 'reminders_disabled' | 'kind_disabled' | 'organizer_suspended'
  | 'email_disabled' | 'event_unavailable' | 'event_cancelled' | 'event_not_live'
  | 'event_reminders_off' | 'event_rescheduled'

/** The job fields the gate reads (anchorMs is absent on jobs created before RD-COMMS-P2-E). */
export type ReminderJobData = ReminderDocData & {
  anchorMs?: unknown
  sendAt?:   { toMillis?: () => number } | null
}

export type ReminderGate =
  | { block: ReminderBlockReason }
  | { block: null; event: Record<string, unknown> | null; logicalKey: string }

/**
 * Whether this reminder may send now. `logicalKey` identifies the reminder for the per-recipient
 * delivery ledger: event + kind + anchor for auto kinds (so a legacy job and its re-keyed successor
 * share it), the job id for anything else.
 */
export async function reminderExecutionBlock(
  id: string, data: ReminderJobData, settings: ReminderSettings, comm: { email: { enabled: boolean } },
): Promise<ReminderGate> {
  const kind = data.kind as ReminderKind
  if (typeof data.organizerUid !== 'string' || !data.organizerUid
    || !REMINDER_KINDS.includes(kind)
    || (data.audience !== 'attendees' && data.audience !== 'organizer')
    || (data.audience === 'attendees' && (typeof data.eventId !== 'string' || !data.eventId))) {
    return { block: 'invalid_reminder' }
  }

  if (!settings.enabled) return { block: 'reminders_disabled' }
  const auto = kind !== 'custom'
  if (auto && settings.kinds[kind as Exclude<ReminderKind, 'custom'>] === false) return { block: 'kind_disabled' }

  if (await isModerated(data.organizerUid)) return { block: 'organizer_suspended' }
  if (!comm.email.enabled) return { block: 'email_disabled' }

  let event: Record<string, unknown> | null = null
  if (typeof data.eventId === 'string' && data.eventId) {
    const snap = await adminDb.collection('events').doc(data.eventId).get()
    event = snap.exists ? snap.data() as Record<string, unknown> : null
    const eventBlock = eventExecutionBlock(event, data.organizerUid)
    if (eventBlock) return { block: eventBlock }

    if (auto) {
      // Read directly (not isEventRemindersEnabled, which fails OPEN for the scheduler): a read
      // error here propagates, and the dispatcher defers the job rather than sending it.
      const pref = await adminDb.doc(`eventReminderPrefs/${data.eventId}`).get()
      if (pref.exists && (pref.data() as { enabled?: unknown }).enabled === false) return { block: 'event_reminders_off' }
    }
  }

  if (auto && isEventAnchoredKind(kind)) {
    if (!event) return { block: 'event_unavailable' }
    const anchor = reminderAnchor(kind, event.eventDetails, event.pricing)
    if (anchor === null) return { block: 'event_rescheduled' }
    if (typeof data.anchorMs === 'number') {
      if (data.anchorMs !== anchor) return { block: 'event_rescheduled' }
    } else {
      // Legacy job: it stored no anchor, so check its sendAt against the current one.
      const sendAtMs = typeof data.sendAt?.toMillis === 'function' ? data.sendAt.toMillis() : NaN
      const offset = settings.offsetHours[kind as Exclude<ReminderKind, 'custom'>]
      if (!Number.isFinite(sendAtMs) || !legacySendAtMatches(sendAtMs, anchor, offset)) return { block: 'event_rescheduled' }
    }
    return { block: null, event, logicalKey: `auto|${data.eventId}|${kind}|${anchor}` }
  }

  return { block: null, event, logicalKey: `job|${id}` }
}
