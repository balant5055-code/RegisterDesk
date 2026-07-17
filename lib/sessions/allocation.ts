// Session-allocation consistency (P1-1). Server-only.
//
// Keeps eventSessions.registeredCount and the attendee's selectedSessions in sync
// across the registration lifecycle. Two usage modes:
//   1. Transaction-body helpers (readSessionSnaps / applyReleaseWrites /
//      applyRestoreWrites) woven INTO the registration cancel/reject/restore
//      transactions, so the status change and the session adjustment are atomic.
//   2. releaseRegistrationSessions — a standalone, idempotent transaction for
//      paths that aren't a single registration txn (e.g. the refund webhook).
//
// On release we MOVE selectedSessions → releasedSessions (not delete) so the prior
// allocation is preserved for audit + can be restored on re-activation.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { SESSIONS, SessionError, type EventSessionDoc } from '@/lib/sessions/types'

type Txn  = FirebaseFirestore.Transaction
type Snap = FirebaseFirestore.DocumentSnapshot

const sessionDoc = (id: string) => adminDb.collection(SESSIONS).doc(id)

/** READ phase: fetch snapshots for the given session ids (de-duplicated). */
export async function readSessionSnaps(tx: Txn, ids: string[]): Promise<Map<string, Snap>> {
  const unique = [...new Set(ids)]
  const snaps = await Promise.all(unique.map(id => tx.get(sessionDoc(id))))
  const map = new Map<string, Snap>()
  unique.forEach((id, i) => map.set(id, snaps[i]))
  return map
}

/** WRITE phase: decrement registeredCount for each held session (clamped ≥ 0 — a
 *  missing session or zero count is skipped, so a re-run can never go negative). */
export function applyReleaseWrites(tx: Txn, ids: string[], snaps: Map<string, Snap>): void {
  for (const id of new Set(ids)) {
    const s = snaps.get(id)
    if (s?.exists && ((s.data() as EventSessionDoc).registeredCount ?? 0) > 0) {
      tx.update(sessionDoc(id), { registeredCount: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() })
    }
  }
}

/** WRITE phase: validate capacity + increment for restore. Throws SESSION_FULL if
 *  a still-published session is at capacity (aborts the whole txn → nothing
 *  restored). Sessions that no longer exist or are cancelled are silently dropped.
 *  Returns the list actually restored. */
export function applyRestoreWrites(tx: Txn, ids: string[], snaps: Map<string, Snap>): string[] {
  const restorable: string[] = []
  for (const id of new Set(ids)) {
    const s = snaps.get(id)
    if (!s?.exists) continue
    const d = s.data() as EventSessionDoc
    if (d.status === 'cancelled') continue
    if (d.capacity !== null && (d.registeredCount ?? 0) >= d.capacity) throw new SessionError('SESSION_FULL', d.title)
    restorable.push(id)
  }
  for (const id of restorable) {
    tx.update(sessionDoc(id), { registeredCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() })
  }
  return restorable
}

/** Standalone, idempotent release used by paths that are not a single registration
 *  transaction (refund webhook / failed-refund retry). No-op when nothing is held. */
export async function releaseRegistrationSessions(registrationId: string): Promise<void> {
  const regRef = adminDb.collection('registrations').doc(registrationId)
  await adminDb.runTransaction(async tx => {
    const regSnap = await tx.get(regRef)
    if (!regSnap.exists) return
    const reg = regSnap.data() as { selectedSessions?: string[] }
    const held = Array.isArray(reg.selectedSessions) ? reg.selectedSessions : []
    if (held.length === 0) return                       // idempotent no-op
    const snaps = await readSessionSnaps(tx, held)       // reads before writes
    applyReleaseWrites(tx, held, snaps)
    tx.update(regRef, {
      selectedSessions:   [],
      releasedSessions:   held,
      sessionsReleasedAt: FieldValue.serverTimestamp(),
      updatedAt:          FieldValue.serverTimestamp(),
    })
  })
}

/** Standalone restore for paths that aren't the capacity-checked restoreRegistration
 *  transaction (e.g. bulk restore). Re-validates + re-allocates releasedSessions.
 *  Throws SessionError('SESSION_FULL') if a still-published session is full (caller
 *  decides how to surface — the daily reconciliation is the backstop). No-op when
 *  nothing was released. */
export async function restoreRegistrationSessions(registrationId: string): Promise<void> {
  const regRef = adminDb.collection('registrations').doc(registrationId)
  await adminDb.runTransaction(async tx => {
    const regSnap = await tx.get(regRef)
    if (!regSnap.exists) return
    const reg = regSnap.data() as { releasedSessions?: string[] }
    const toRestore = Array.isArray(reg.releasedSessions) ? reg.releasedSessions : []
    if (toRestore.length === 0) return                  // idempotent no-op
    const snaps = await readSessionSnaps(tx, toRestore)
    const restored = applyRestoreWrites(tx, toRestore, snaps)
    tx.update(regRef, {
      selectedSessions:   restored,
      releasedSessions:   [],
      sessionsRestoredAt: FieldValue.serverTimestamp(),
      updatedAt:          FieldValue.serverTimestamp(),
    })
  })
}
