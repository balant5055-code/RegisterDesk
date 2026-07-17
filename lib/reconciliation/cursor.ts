// Durable resume cursors for the global reconcilers (Phase G.5 scalability).
// Server-only.
//
// Each reconciler processes a BOUNDED page of entities per run (ordered by document
// id) and records the last id it reached here. The next run resumes after that id,
// so the full set is covered across successive daily ticks instead of in one
// unbounded scan that would time out at thousands of events/organizers. When a page
// comes back short (end of the collection reached) the cursor is cleared so the next
// run wraps back to the start. The per-entity verification/repair logic is unchanged.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

const CURSORS = 'reconciliationCursors'

/** Read the saved resume cursor (last processed doc id) for a reconciler, or null
 *  to start from the beginning. Best-effort — a read failure just restarts the page. */
export async function readCursor(key: string): Promise<string | null> {
  try {
    const snap = await adminDb.collection(CURSORS).doc(key).get()
    const v = snap.exists ? (snap.data() as { after?: unknown }).after : null
    return typeof v === 'string' && v ? v : null
  } catch {
    return null
  }
}

/** Persist the resume cursor. `after = null` wraps back to the start next run.
 *  Best-effort — a write failure just re-covers the same page on the next run. */
export async function writeCursor(key: string, after: string | null): Promise<void> {
  try {
    await adminDb.collection(CURSORS).doc(key).set(
      { after: after ?? null, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
  } catch {
    /* best-effort */
  }
}
