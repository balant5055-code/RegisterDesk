// RD-EVENT-TYPES-01 — the runtime event-type switches. SERVER-ONLY.
//
//   platformSettings/eventTypes { enabled: { [eventTypeId]: boolean }, updatedAt, updatedBy }
//
// Changed only by PUT /api/admin/settings/event-types (Super Admin, reason required), with the admin
// audit row staged in the SAME transaction as the change. Read by the routes that create or retype a
// draft, duplicate an event, or first-submit an event, and by the wizard (through its own route).
//
// Safe default: if the document cannot be read, the launch defaults apply (three types on, the rest
// "Coming Soon") — never "everything enabled".

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import {
  resolveEventTypeAvailability, DEFAULT_EVENT_TYPE_AVAILABILITY, isEventTypeId,
  type EventTypeAvailability, type EventTypeId,
} from './eventTypeAvailability'

export const EVENT_TYPE_SETTINGS_DOC = 'platformSettings/eventTypes'

export async function getEventTypeAvailability(): Promise<{ availability: EventTypeAvailability; unavailable: boolean }> {
  try {
    const snap = await adminDb.doc(EVENT_TYPE_SETTINGS_DOC).get()
    return { availability: resolveEventTypeAvailability(snap.data()), unavailable: false }
  } catch (err) {
    console.error('[event-types] availability read failed — launch defaults apply', err instanceof Error ? err.message : err)
    return { availability: { ...DEFAULT_EVENT_TYPE_AVAILABILITY }, unavailable: true }
  }
}

/** Applies a partial set of switches (known ids, booleans) and stages the audit row with it. */
export async function setEventTypeAvailability(patch: Partial<Record<EventTypeId, boolean>>, adminUid: string, reason: string): Promise<EventTypeAvailability> {
  const clean: Partial<Record<EventTypeId, boolean>> = {}
  for (const [k, v] of Object.entries(patch)) if (isEventTypeId(k) && typeof v === 'boolean') clean[k] = v
  const ref = adminDb.doc(EVENT_TYPE_SETTINGS_DOC)
  return adminDb.runTransaction(async txn => {
    const snap = await txn.get(ref)
    const before = resolveEventTypeAvailability(snap.data())
    const after: EventTypeAvailability = { ...before, ...clean }
    const changed = (Object.keys(clean) as EventTypeId[]).filter(k => before[k] !== after[k])
    // Every switch is stored explicitly, so a later change of the code defaults can never flip a
    // type an administrator already decided about.
    txn.set(ref, { enabled: after, updatedAt: FieldValue.serverTimestamp(), updatedBy: adminUid }, { merge: true })
    stageAdminAudit(txn, {
      adminUid, actorRole: 'super_admin', action: 'platform.event_type_availability_changed', entityType: 'platform_settings',
      entityId: 'eventTypes', reason, changedFields: changed,
      before: Object.fromEntries(changed.map(k => [k, before[k]])), after: Object.fromEntries(changed.map(k => [k, after[k]])),
    })
    return after
  })
}
