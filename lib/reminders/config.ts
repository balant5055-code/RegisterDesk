// Reminder settings — server-only. Reminder-SPECIFIC policy (global enable, which
// auto kinds fire, default lead times, retry) lives in one doc `system/reminderSettings`.
// CHANNEL policy (email/whatsapp enabled, pricing) is NOT duplicated here — it stays
// in Business Configuration and is read at dispatch via getCommunicationConfig.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { AUTO_REMINDER_KINDS, type ReminderKind } from './types'
import { isValidOffsetHours } from './anchor'

type AutoKind = Exclude<ReminderKind, 'custom'>

export interface ReminderSettings {
  enabled:     boolean                       // global master switch
  kinds:       Record<AutoKind, boolean>     // per auto-kind enable
  offsetHours: Record<AutoKind, number>      // lead time (hours before anchor); event_today is special
  // RD-COMMS-P2-E — how many times a dispatch INTERRUPTED mid-send (the function died while
  // 'sending') is resumed. A resumed dispatch only reaches recipients with no delivery record,
  // so nobody is emailed twice; 0 = an interrupted reminder is failed, never resumed.
  // A recipient's own send is never retried here (the notification engine already retries a
  // DEFINITE rejection, and never an unknown outcome — RD-COMMS-P2-D).
  retryCount:  number
}

const MAX_RETRY_COUNT = 5     // the admin console's own input bound

const SETTINGS_DEFAULTS: ReminderSettings = {
  enabled: true,
  kinds: {
    event_tomorrow: true, event_today: true, event_starting_soon: true,
    registration_closing: true, early_bird_ending: true, low_wallet: true,
  },
  offsetHours: {
    event_tomorrow: 24, event_today: 0, event_starting_soon: 1,
    registration_closing: 24, early_bird_ending: 24, low_wallet: 0,
  },
  retryCount: 1,
}

const SETTINGS_DOC = adminDb.doc('system/reminderSettings')
const TTL_MS = 60_000
let cache: { value: ReminderSettings; at: number } | null = null

const isRetryCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_RETRY_COUNT

// RD-COMMS-P2-E — every stored value is validated PER FIELD. A malformed offset (NaN, Infinity,
// negative, a string) used to flow straight into the scheduler's date maths, where it threw and
// stopped every reminder on the platform. It now falls back to that kind's default instead.
function merge(stored: Partial<ReminderSettings> | undefined): ReminderSettings {
  const kinds = { ...SETTINGS_DEFAULTS.kinds }
  const offsetHours = { ...SETTINGS_DEFAULTS.offsetHours }
  for (const k of AUTO_REMINDER_KINDS) {
    const on = (stored?.kinds as Record<string, unknown> | undefined)?.[k]
    if (typeof on === 'boolean') kinds[k] = on
    const off = (stored?.offsetHours as Record<string, unknown> | undefined)?.[k]
    if (isValidOffsetHours(off)) offsetHours[k] = off
  }
  return {
    enabled:    typeof stored?.enabled === 'boolean' ? stored.enabled : SETTINGS_DEFAULTS.enabled,
    kinds,
    offsetHours,
    retryCount: isRetryCount(stored?.retryCount) ? stored.retryCount : SETTINGS_DEFAULTS.retryCount,
  }
}

/** Effective reminder settings (60s cached, fail-safe to defaults). `fresh` skips the cache —
 *  the dispatcher reads it that way so a switch turned off a moment ago is honoured. */
export async function getReminderSettings(opts: { fresh?: boolean } = {}): Promise<ReminderSettings> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value
  try {
    const snap = await SETTINGS_DOC.get()
    const value = merge(snap.exists ? (snap.data() as Partial<ReminderSettings>) : undefined)
    cache = { value, at: Date.now() }
    return value
  } catch {
    return SETTINGS_DEFAULTS   // fail-safe (do not cache the failure)
  }
}

export const REMINDER_SETTINGS_DEFAULTS = SETTINGS_DEFAULTS

/** A rejected admin settings change (→ 400). */
export class ReminderSettingsError extends Error {}

/** RD-COMMS-P2-E — the problems with an admin PATCH, or [] when every supplied field is valid. */
export function reminderSettingsPatchIssues(patch: unknown): string[] {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['Settings must be an object']
  const p = patch as Record<string, unknown>
  const issues: string[] = []
  const autoKinds = new Set<string>(AUTO_REMINDER_KINDS)
  if (p.enabled !== undefined && typeof p.enabled !== 'boolean') issues.push('enabled must be true or false')
  if (p.kinds !== undefined) {
    if (!p.kinds || typeof p.kinds !== 'object' || Array.isArray(p.kinds)) issues.push('kinds must be an object')
    else for (const [k, v] of Object.entries(p.kinds)) {
      if (!autoKinds.has(k)) issues.push(`Unknown reminder kind: ${k}`)
      else if (typeof v !== 'boolean') issues.push(`kinds.${k} must be true or false`)
    }
  }
  if (p.offsetHours !== undefined) {
    if (!p.offsetHours || typeof p.offsetHours !== 'object' || Array.isArray(p.offsetHours)) issues.push('offsetHours must be an object')
    else for (const [k, v] of Object.entries(p.offsetHours)) {
      if (!autoKinds.has(k)) issues.push(`Unknown reminder kind: ${k}`)
      else if (!isValidOffsetHours(v)) issues.push(`offsetHours.${k} must be a finite number of hours, 0 or more`)
    }
  }
  if (p.retryCount !== undefined && !isRetryCount(p.retryCount)) issues.push(`retryCount must be a whole number from 0 to ${MAX_RETRY_COUNT}`)
  return issues
}

/** Admin update of global reminder settings. Invalidates the cache. Throws ReminderSettingsError
 *  on any invalid field — nothing is written. */
export async function updateReminderSettings(patch: Partial<ReminderSettings>, adminUid: string): Promise<ReminderSettings> {
  const issues = reminderSettingsPatchIssues(patch)
  if (issues.length) throw new ReminderSettingsError(issues.join('; '))
  const current = merge((await SETTINGS_DOC.get()).data() as Partial<ReminderSettings> | undefined)
  const next: ReminderSettings = {
    enabled:    typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    kinds:      { ...current.kinds,      ...(patch.kinds ?? {}) },
    offsetHours:{ ...current.offsetHours, ...(patch.offsetHours ?? {}) },
    retryCount: typeof patch.retryCount === 'number' ? patch.retryCount : current.retryCount,
  }
  await SETTINGS_DOC.set({ ...next, updatedBy: adminUid, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  cache = null
  return next
}

// ─── Per-event organizer preference (opt-out of auto reminders for one event) ──

/** Whether auto reminders are enabled for an event (organizer opt-out). Default true. */
export async function isEventRemindersEnabled(eventId: string): Promise<boolean> {
  try {
    const snap = await adminDb.doc(`eventReminderPrefs/${eventId}`).get()
    if (!snap.exists) return true
    const v = (snap.data() as { enabled?: unknown }).enabled
    return v !== false
  } catch {
    return true
  }
}

export async function setEventRemindersEnabled(eventId: string, organizerUid: string, enabled: boolean): Promise<void> {
  await adminDb.doc(`eventReminderPrefs/${eventId}`).set({
    eventId, organizerUid, enabled, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}
