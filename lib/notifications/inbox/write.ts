// Organizer Notification Center — write path (Phase H.4.3). Server-only.
//
// The SINGLE place that persists an inbox notification. Mirrors writeEmailLog:
// strips undefined (the Admin SDK rejects undefined values), never throws (a
// notification failure must never break the primary event flow), and supports
// deterministic de-duplication so the same logical event is stored once.
//
// Never import from client components.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { CATEGORY_META } from './catalog'
import type { WriteNotificationInput } from './types'

function collectionFor(workspaceUid: string) {
  return adminDb.collection(`users/${workspaceUid}/notifications`)
}

/**
 * Persist one inbox notification under the owner's workspace.
 * Returns the document id (or '' on failure / skipped duplicate). Never throws.
 */
export async function writeNotification(input: WriteNotificationInput): Promise<string> {
  const { workspaceUid, dedupeId, ...rest } = input
  if (!workspaceUid) return ''

  try {
    const col = collectionFor(workspaceUid)
    const ref = dedupeId ? col.doc(dedupeId) : col.doc()

    // De-dupe: if a deterministic id was supplied and already exists, skip.
    if (dedupeId) {
      const existing = await ref.get()
      if (existing.exists) return ref.id
    }

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
    await ref.set({ ...clean, createdAt: now, updatedAt: now })
    return ref.id
  } catch (err) {
    console.error('[notifications] write failed:', err)
    return ''
  }
}
