// RD-PHOTO-01 · The per-event photo-capacity counter — SERVER ONLY.
//
//   eventPhotoUsage/{draftId}  { draftId, organizerUid, held, writes, lastReason, updatedAt }
//
// `held` is the number of the event's media assets that occupy a unit of its PAID photo capacity
// (status `pending` or `ready`). It changes only inside the transactions that change those statuses:
//   +1  reservePhotoUpload   (a new `pending` reservation — the capacity decision itself)
//   −1  markAssetDeleted     (pending | ready → deleted)
//   −1  purgeReclaimedAsset  (an abandoned `pending` reservation is removed)
// so it is exact by construction. A missing counter (events that predate it) is initialised from an
// aggregate count the first time a capacity transaction needs it. Every capacity-changing
// transaction (upload, photo refund, photo carry-forward) writes this document, which is what
// serialises them: two of them can never spend the same unit.
//
// Lives apart from assetRepo / photoCapacityGate so both can import it without a cycle.

import type { Transaction, DocumentSnapshot } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export const EVENT_PHOTO_USAGE = 'eventPhotoUsage'
export const photoUsageLockRef = (draftId: string) => adminDb.collection(EVENT_PHOTO_USAGE).doc(draftId)

/** The recorded counter, or null when it has never been initialised. */
export function heldOf(snap: DocumentSnapshot | null | undefined): number | null {
  const v = snap?.exists ? snap.get('held') : undefined
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/**
 * Inside a status-changing transaction (after its reads): one photo stopped occupying capacity.
 * A counter that was never initialised is left alone — the next capacity transaction counts.
 */
export function txnReleaseHeldPhoto(txn: Transaction, lockSnap: DocumentSnapshot, draftId: string): void {
  const held = heldOf(lockSnap)
  if (held === null) return
  txn.set(photoUsageLockRef(draftId), { held: Math.max(0, held - 1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
}
