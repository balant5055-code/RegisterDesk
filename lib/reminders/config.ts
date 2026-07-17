// Reminder settings — server-only. Reminder-SPECIFIC policy (global enable, which
// auto kinds fire, default lead times, retry) lives in one doc `system/reminderSettings`.
// CHANNEL policy (email/whatsapp enabled, pricing) is NOT duplicated here — it stays
// in Business Configuration and is read at dispatch via getCommunicationConfig.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import type { ReminderKind } from './types'

type AutoKind = Exclude<ReminderKind, 'custom'>

export interface ReminderSettings {
  enabled:     boolean                       // global master switch
  kinds:       Record<AutoKind, boolean>     // per auto-kind enable
  offsetHours: Record<AutoKind, number>      // lead time (hours before anchor); event_today is special
  retryCount:  number                        // dispatch retry attempts on failure
}

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

function merge(stored: Partial<ReminderSettings> | undefined): ReminderSettings {
  return {
    enabled:    typeof stored?.enabled === 'boolean' ? stored.enabled : SETTINGS_DEFAULTS.enabled,
    kinds:      { ...SETTINGS_DEFAULTS.kinds,      ...(stored?.kinds ?? {}) },
    offsetHours:{ ...SETTINGS_DEFAULTS.offsetHours, ...(stored?.offsetHours ?? {}) },
    retryCount: typeof stored?.retryCount === 'number' && stored.retryCount >= 0 ? stored.retryCount : SETTINGS_DEFAULTS.retryCount,
  }
}

/** Effective reminder settings (60s cached, fail-safe to defaults). */
export async function getReminderSettings(): Promise<ReminderSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
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

/** Admin update of global reminder settings. Invalidates the cache. */
export async function updateReminderSettings(patch: Partial<ReminderSettings>, adminUid: string): Promise<ReminderSettings> {
  const current = merge((await SETTINGS_DOC.get()).data() as Partial<ReminderSettings> | undefined)
  const next: ReminderSettings = {
    enabled:    typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    kinds:      { ...current.kinds,      ...(patch.kinds ?? {}) },
    offsetHours:{ ...current.offsetHours, ...(patch.offsetHours ?? {}) },
    retryCount: typeof patch.retryCount === 'number' && patch.retryCount >= 0 ? patch.retryCount : current.retryCount,
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
