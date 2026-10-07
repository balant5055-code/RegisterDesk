// RD-PHOTO-01 · The event photo-capacity GATE — SERVER ONLY.
//
// Every Media Studio upload takes one unit of the event's PAID photo capacity (lib/licensing/
// photoCapacity.ts) at /uploads/prepare, before any signed URL exists. The decision, the `pending`
// reservation it authorizes and the event's counter (`eventPhotoUsage/{draftId}.held`, see
// repositories/photoUsageLock.ts) are written in ONE transaction. Firestore serialises transactions
// that write the same document, so two tabs, four parallel uploads or two devices can never take
// more units than the event has paid for. The transaction is two point reads and two writes — no
// query — so it stays cheap at 3,000 photos. A Super Admin photo refund / carry-forward writes the
// same counter document (lib/wallet/serviceRequests.ts), so a refund and an upload can never both
// spend the same unit.

import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { ledgerRef, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import {
  paidPhotoCapacity, photoCapacityFigures, PHOTO_CAPACITY_REQUIRED_MESSAGE,
  type PhotoCapacityFigures,
} from '@/lib/licensing/photoCapacity'
import { MEDIA_ASSETS } from '@/features/media-studio/types'
import {
  photoCapacityUsageQuery, reservationData, type ReserveAssetInput,
} from '@/features/media-studio/repositories/assetRepo'
import { heldOf, photoUsageLockRef } from '@/features/media-studio/repositories/photoUsageLock'

export { EVENT_PHOTO_USAGE, photoUsageLockRef } from '@/features/media-studio/repositories/photoUsageLock'

/** The ledger's media line, but only when the ledger belongs to this organizer (event A/B isolation). */
function ownedMediaLine(snap: FirebaseFirestore.DocumentSnapshot, organizerUid: string) {
  if (!snap.exists) return undefined
  const d = snap.data() as ServiceLedgerDoc
  return d.organizerUid === organizerUid ? d.media : undefined
}

/**
 * Inside a transaction (reads only): the event's paid capacity and the photos holding it. The
 * counter is used when initialised; otherwise (first use) it is counted once from the assets.
 */
export async function txnReadPhotoCapacity(
  txn: Transaction, organizerUid: string, draftId: string,
): Promise<{ capacity: number; used: number }> {
  const [ledgerSnap, lockSnap] = await Promise.all([txn.get(ledgerRef(draftId)), txn.get(photoUsageLockRef(draftId))])
  const held = heldOf(lockSnap)
  const used = held ?? (await txn.get(photoCapacityUsageQuery(organizerUid, draftId).count())).data().count
  return { capacity: paidPhotoCapacity(ownedMediaLine(ledgerSnap, organizerUid)), used }
}

/** The counter write every capacity-changing transaction makes (serialises them). */
export function txnTouchPhotoLock(
  txn: Transaction, organizerUid: string, draftId: string, reason: 'upload' | 'refund' | 'carry_forward', held: number,
): void {
  txn.set(photoUsageLockRef(draftId), {
    draftId, organizerUid, held, lastReason: reason, writes: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })
}

export type PhotoReservation =
  | { ok: true; figures: PhotoCapacityFigures }
  | { ok: false; status: 402 | 409; code: 'PHOTO_CAPACITY_REQUIRED' | 'PHOTO_CAPACITY_FULL'; error: string; figures: PhotoCapacityFigures }

/**
 * Takes one unit of the event's paid photo capacity and writes the `pending` reservation for it,
 * atomically. Never grants an unpaid unit: no ledger, a foreign ledger, or a full event ⇒ refused.
 */
export async function reservePhotoUpload(input: ReserveAssetInput): Promise<PhotoReservation> {
  // A burst of uploads for ONE event contends on its counter document. Firestore aborts the losers
  // (ABORTED) after its own retries; a few more jittered attempts absorb a burst. Still fail-closed:
  // if contention persists the error reaches the route, which issues no upload URL.
  for (let attempt = 0; ; attempt++) {
    try {
      return await reserveOnce(input)
    } catch (err) {
      const aborted = (err as { code?: unknown })?.code === 10 || /ABORTED|contention/i.test(String((err as Error)?.message ?? ''))
      if (!aborted || attempt >= 4) throw err
      await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 250) * (attempt + 1)))
    }
  }
}

async function reserveOnce(input: ReserveAssetInput): Promise<PhotoReservation> {
  const assetRef = adminDb.collection(MEDIA_ASSETS).doc(input.assetId)
  return adminDb.runTransaction<PhotoReservation>(async txn => {
    const { capacity, used } = await txnReadPhotoCapacity(txn, input.organizerUid, input.eventId)
    const figures = photoCapacityFigures(capacity, used)
    if (capacity <= 0) {
      return { ok: false, status: 402, code: 'PHOTO_CAPACITY_REQUIRED', error: `Photo capacity required. ${PHOTO_CAPACITY_REQUIRED_MESSAGE}`, figures }
    }
    if (used + 1 > capacity) {
      return {
        ok: false, status: 409, code: 'PHOTO_CAPACITY_FULL', figures,
        error: `This event's paid photo capacity (${capacity.toLocaleString('en-IN')}) is fully used. Purchase more photo capacity from License & Services.`,
      }
    }
    txnTouchPhotoLock(txn, input.organizerUid, input.eventId, 'upload', used + 1)
    txn.set(assetRef, reservationData(input))
    return { ok: true, figures: photoCapacityFigures(capacity, used + 1) }
  })
}

/** Outside a transaction: the figures the Media Studio / Wallet surfaces display. */
export async function readEventPhotoCapacity(organizerUid: string, draftId: string): Promise<PhotoCapacityFigures & { stored: number; inFlight: number }> {
  const [ledgerSnap, usedAgg, readyAgg] = await Promise.all([
    ledgerRef(draftId).get(),
    photoCapacityUsageQuery(organizerUid, draftId).count().get(),
    adminDb.collection(MEDIA_ASSETS).where('organizerUid', '==', organizerUid).where('eventId', '==', draftId).where('status', '==', 'ready').count().get(),
  ])
  const used = usedAgg.data().count, stored = readyAgg.data().count
  return { ...photoCapacityFigures(paidPhotoCapacity(ownedMediaLine(ledgerSnap, organizerUid)), used), stored, inFlight: Math.max(0, used - stored) }
}
