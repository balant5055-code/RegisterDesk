// RD-COMMS-P2-E — WHEN an auto reminder is anchored, in the EVENT's own timezone. Pure.
//
// Shared by the scheduler (which creates the job) and the dispatcher (which re-derives the anchor
// from the CURRENT event and refuses to send a job built from an old date/time).
//
// Timezone source — the one the platform already treats as authoritative:
//   eventDetails.schedule.timezone   an IANA name, validated at publish (validatePublish.ts)
//   missing                          'Asia/Kolkata' — the platform's long-standing assumption
//                                    ("event times are IST throughout", lib/calendar/ics.ts)
//   present but NOT a valid zone     NO anchor: the reminder is not scheduled, and an existing
//                                    job is not sent. A corrupted zone is never read as IST.

import { isValidTimezone, zonedWallTimeUtc } from '@/lib/registrations/zonedDayRange'
import type { ReminderKind } from './types'

export const REMINDER_FALLBACK_TIMEZONE = 'Asia/Kolkata'

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k] }
  return cur
}

/** The event's timezone, the fallback when none is stored, or null when the stored value is malformed. */
export function reminderTimezone(eventDetails: unknown): string | null {
  const raw = nested(eventDetails, 'schedule', 'timezone')
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) return REMINDER_FALLBACK_TIMEZONE
  if (typeof raw !== 'string') return null
  const tz = raw.trim()
  return isValidTimezone(tz) ? tz : null
}

/** Local 'YYYY-MM-DD' + optional 'HH:MM' (default 00:00) in `tz` → epoch ms, or null when malformed. */
function localEpochMs(dateStr: unknown, timeStr: unknown, tz: string): number | null {
  if (typeof dateStr !== 'string') return null
  const time = typeof timeStr === 'string' && timeStr.trim() ? timeStr.trim() : '00:00'
  return zonedWallTimeUtc(dateStr.trim(), time, tz)?.getTime() ?? null
}

/** Anchor epoch (ms) for an auto event-kind, or null when not applicable / not derivable. */
export function reminderAnchor(kind: ReminderKind, eventDetails: unknown, pricing: unknown): number | null {
  const tz = reminderTimezone(eventDetails)
  if (!tz) return null
  const startDate = nested(eventDetails, 'schedule', 'startDate')
  switch (kind) {
    case 'event_tomorrow':
    case 'event_starting_soon':
      return localEpochMs(startDate, nested(eventDetails, 'schedule', 'startTime'), tz)
    case 'event_today':
      // Morning-of: 08:00 event-local on the event day.
      return localEpochMs(startDate, '08:00', tz)
    case 'registration_closing':
      return localEpochMs(nested(pricing, 'registrationEndDate'), '23:59', tz)
    case 'early_bird_ending': {
      const passes = nested(pricing, 'passes')
      if (!Array.isArray(passes)) return null
      const ends = passes
        .filter(p => (p as Record<string, unknown>)?.earlyBirdEnabled === true && typeof (p as Record<string, unknown>).earlyBirdEndDate === 'string')
        .map(p => localEpochMs((p as Record<string, unknown>).earlyBirdEndDate, '23:59', tz))
        .filter((n): n is number => n !== null)
      return ends.length ? Math.min(...ends) : null
    }
    default:
      return null
  }
}

/** Auto kinds anchored to the event (everything but the retired low_wallet and organizer-authored custom). */
export function isEventAnchoredKind(kind: ReminderKind): boolean {
  return kind === 'event_tomorrow' || kind === 'event_today' || kind === 'event_starting_soon'
    || kind === 'registration_closing' || kind === 'early_bird_ending'
}

/**
 * A valid reminder lead time (hours before the anchor). The product rule (types.ts OFFSET_PRESETS):
 * 0 = immediately, any positive value otherwise. NaN, ±Infinity, negatives and non-numbers are invalid.
 */
export function isValidOffsetHours(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/** How late after its due time an auto reminder may still be created (and its sendAt clamped to now). */
export const REMINDER_GRACE_MS = 2 * 60 * 60 * 1000

/** The deterministic id of an auto reminder: one per event, kind AND anchor instant. A changed event
 *  date/time is a different anchor, so it gets a fresh job instead of reusing the stale one. */
export function autoReminderId(eventId: string, kind: ReminderKind, anchorMs: number): string {
  return `rem_${eventId}_${kind}_${anchorMs}`
}

/** The id format used before RD-COMMS-P2-E (no anchor). Such jobs are still honoured — see below. */
export function legacyAutoReminderId(eventId: string, kind: ReminderKind): string {
  return `rem_${eventId}_${kind}`
}

/**
 * Whether a LEGACY auto job (no stored anchor) was built for this anchor: the old scheduler stored
 * sendAt = max(anchor − offset, creation time) and only created within REMINDER_GRACE_MS of the due
 * time, so its sendAt lies in [due, due + grace]. One minute of slack each side.
 */
export function legacySendAtMatches(sendAtMs: number, anchorMs: number, offsetHours: number): boolean {
  const due = anchorMs - offsetHours * 60 * 60 * 1000
  return sendAtMs >= due - 60_000 && sendAtMs <= due + REMINDER_GRACE_MS + 60_000
}
