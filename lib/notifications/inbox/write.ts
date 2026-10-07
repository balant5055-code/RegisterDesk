// Organizer Notification Center — write path (Phase H.4.3). Server-only.
//
// The SINGLE place that persists an inbox notification. Mirrors writeEmailLog:
// strips undefined (the Admin SDK rejects undefined values), never throws (a
// notification failure must never break the primary event flow), and supports
// deterministic de-duplication so the same logical event is stored once.
//
// Never import from client components.

import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { CATEGORY_META } from './catalog'
import type { WriteNotificationInput } from './types'

function collectionFor(workspaceUid: string) {
  return adminDb.collection(`users/${workspaceUid}/notifications`)
}

/**
 * The document one notification would be stored as, WITHOUT writing it — so a caller that
 * must commit the notification atomically with its own state change (the WhatsApp Inbox
 * routing transaction) can `txn.set(ref, data)` instead of writing after the fact.
 * Same shape, defaults and undefined-stripping as writeNotification. Null when there is no
 * workspace to write under.
 */
export function prepareNotification(input: WriteNotificationInput): { ref: DocumentReference; data: Record<string, unknown> } | null {
  const { workspaceUid, dedupeId, ...rest } = input
  if (!workspaceUid) return null
  const col = collectionFor(workspaceUid)
  const ref = dedupeId ? col.doc(dedupeId) : col.doc()

  // Never write undefined — omit any undefined key and apply catalog defaults.
  const doc: Record<string, unknown> = {
    category:       rest.category,
    type:           rest.type,
    title:          rest.title,
    body:           rest.body,
    severity:       rest.severity ?? CATEGORY_META[rest.category].defaultSeverity,
    actionRequired: rest.actionRequired ?? false,
    link:           rest.link ?? null,
    eventId:        rest.eventId ?? null,
    eventName:      rest.eventName ?? null,
    read:           false,
  }
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(doc)) {
    if (v !== undefined) clean[k] = v
  }
  const now = FieldValue.serverTimestamp()
  return { ref, data: { ...clean, createdAt: now, updatedAt: now } }
}

/**
 * Persist one inbox notification under the owner's workspace.
 * Returns the document id (or '' on failure / skipped duplicate). Never throws.
 */
export async function writeNotification(input: WriteNotificationInput): Promise<string> {
  try {
    const prepared = prepareNotification(input)
    if (!prepared) return ''

    // De-dupe: if a deterministic id was supplied and already exists, skip.
    if (input.dedupeId) {
      const existing = await prepared.ref.get()
      if (existing.exists) return prepared.ref.id
    }

    await prepared.ref.set(prepared.data)
    return prepared.ref.id
  } catch (err) {
    console.error('[notifications] write failed:', err)
    return ''
  }
}
