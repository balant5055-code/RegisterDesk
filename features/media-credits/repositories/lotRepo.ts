// RD-MC-REFUND-V2-P1 · Credit lot Firestore I/O — SERVER ONLY.
//
// NO BUSINESS LOGIC. FIFO lives in `utils/creditLots.ts`, which is pure. This file knows how
// a lot is stored and nothing about which one to spend.
//
// ═══ WHY THE ORDERING KEY IS SPARSE ══════════════════════════════════════════
// `lotSeq` exists only while a lot has credits left. Firestore omits documents that lack an
// ordered field, so a drained lot disappears from the open-lot query rather than being paged
// past. Without that, every settlement would read the organizer's entire purchase history
// INSIDE a transaction — read-set contention that grows forever.
//
// The alternative, `where creditsRemaining > 0`, is not usable: Firestore requires the
// inequality field to be the first `orderBy`, which would order by size instead of age and
// break FIFO.

import { FieldValue, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_GRANTS, MEDIA_CREDIT_PURCHASES,
  type CreditGrantDoc, type CreditPurchaseDoc,
} from '@/features/media-credits/types'
import type { CreditLot, LotDebit } from '@/features/media-credits/utils/creditLots'

const purchases = () => adminDb.collection(MEDIA_CREDIT_PURCHASES)
const grants    = () => adminDb.collection(MEDIA_CREDIT_GRANTS)

/**
 * How many open lots one settlement may consider.
 *
 * A ceiling on the transaction's read set, not a business rule. An organizer with more open
 * lots than this has bought far more than they have used, and the oldest 50 will cover any
 * realistic session — a 10,000-slot session against 50 lots needs each to be under 200
 * credits to overflow, which the shortfall report would then surface rather than hide.
 */
export const MAX_OPEN_LOTS = 50

const toMs = (v: unknown): number =>
  v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0

/**
 * Every lot with credits left, oldest first, read INSIDE the caller's transaction.
 *
 * Two queries because purchases and grants are separate collections; the merge and the
 * ordering happen in `allocateFifo`, which is pure and tested. Both are bounded by
 * `MAX_OPEN_LOTS`, so the read set has a fixed ceiling regardless of account age.
 *
 * MUST be called before the caller's first write — Firestore forbids a read after a write.
 */
export async function readOpenLotsInTx(
  tx: Transaction, organizerUid: string,
): Promise<CreditLot[]> {
  const [pSnap, gSnap] = await Promise.all([
    tx.get(purchases()
      .where('organizerUid', '==', organizerUid)
      .orderBy('lotSeq', 'asc')
      .limit(MAX_OPEN_LOTS)),
    tx.get(grants()
      .where('organizerUid', '==', organizerUid)
      .orderBy('lotSeq', 'asc')
      .limit(MAX_OPEN_LOTS)),
  ])

  const lots: CreditLot[] = []

  for (const d of pSnap.docs) {
    const doc = d.data() as CreditPurchaseDoc
    // Only a granted purchase holds credits. A `pending` or `paid` one has none behind it
    // yet, and a `failed` one never will — neither may be spent from.
    if (doc.status !== 'granted') continue
    lots.push({
      lotId: doc.purchaseId, kind: 'purchase',
      seq: doc.lotSeq ?? toMs(doc.grantedAt),
      remaining: doc.creditsRemaining ?? doc.credits,
    })
  }

  for (const d of gSnap.docs) {
    const doc = d.data() as CreditGrantDoc
    lots.push({
      lotId: doc.grantId, kind: 'grant',
      seq: doc.lotSeq ?? toMs(doc.createdAt),
      remaining: doc.creditsRemaining ?? doc.credits,
    })
  }

  return lots
}

/**
 * Applies debits to their lots, inside the caller's transaction.
 *
 * A lot that reaches zero has its ordering key DELETED, which is what removes it from every
 * future open-lot query. `tx.update` rather than `set`: these documents are financial records
 * and a partial write must never create one that did not exist.
 */
export function applyDebitsInTx(tx: Transaction, debits: readonly LotDebit[]): void {
  for (const d of debits) {
    const ref = d.kind === 'purchase' ? purchases().doc(d.lotId) : grants().doc(d.lotId)
    tx.update(ref, {
      creditsRemaining: d.remainingAfter,
      // Drained ⇒ leave the index. Still open ⇒ untouched, so its age is preserved.
      ...(d.remainingAfter === 0 ? { lotSeq: FieldValue.delete() } : {}),
    })
  }
}

/**
 * Reads one purchase's lot, for a refund.
 *
 * Returns null when the purchase is not granted or holds nothing — a refund of a lot with no
 * credits left must not decrement anything.
 */
export async function readPurchaseLotInTx(
  tx: Transaction, purchaseId: string,
): Promise<CreditLot | null> {
  const snap = await tx.get(purchases().doc(purchaseId))
  if (!snap.exists) return null
  const doc = snap.data() as CreditPurchaseDoc
  if (doc.status !== 'granted') return null
  return {
    lotId: doc.purchaseId, kind: 'purchase',
    seq: doc.lotSeq ?? toMs(doc.grantedAt),
    remaining: doc.creditsRemaining ?? doc.credits,
  }
}

/**
 * RD-MC-REFUND-V2-P3 · take a lot OUT of FIFO while a refund request is pending.
 *
 * ═══ WHY THE WALLET HOLD IS NOT ENOUGH ═══════════════════════════════════════
 * `refundHeldCredits` stops the wallet being overdrawn, but it does not say WHICH credits are
 * spoken for. An organizer with two purchases and a pending refund on the older one still has
 * availability to upload, and FIFO — correctly, knowing nothing about refunds — would drain
 * the older lot first. The reserved credits would be gone, the approval would then refuse,
 * and the organizer would be told to ask again for less.
 *
 * ═══ HOW ════════════════════════════════════════════════════════════════════
 * By deleting the ordering key, which is exactly what a DRAINED lot does. The open-lot query
 * orders by `lotSeq`, and Firestore omits documents that lack an ordered field — so this
 * reuses the mechanism already in place rather than adding a "reserved" flag and a second
 * rule for the allocator to honour. `allocateFifo` needs no change and learns nothing about
 * refunds.
 *
 * `creditsRemaining` is deliberately UNTOUCHED: the credits are still owned, still counted by
 * the invariant, and still the basis of the frozen quote. They are merely unreachable.
 *
 * The caller must record the seq it removed — see `restoreLotInTx`.
 */
export function reserveLotInTx(tx: Transaction, purchaseId: string): void {
  tx.update(purchases().doc(purchaseId), { lotSeq: FieldValue.delete() })
}

/**
 * RD-MC-REFUND-V2-P3 · put a lot back into FIFO when its refund is rejected or cancelled.
 *
 * Restored to its ORIGINAL seq, carried on the refund record, so the lot returns to its true
 * place in the queue rather than to the back of it. A lot that came back with a fresh
 * timestamp would be spent after purchases made later than it, which is the opposite of FIFO
 * and would quietly change which credits a subsequent refund is entitled to.
 *
 * A refund with NO recorded seq is one written before P3. It never removed the key, so there
 * is nothing to put back and this does nothing — restoring would be inventing an ordering
 * that was never taken away. Deliberately not a `serverTimestamp()` fallback either: `lotSeq`
 * is epoch millis, and a Timestamp in the same ordered field would order against every
 * numeric lot unpredictably.
 */
export function restoreLotInTx(
  tx: Transaction, purchaseId: string, lotSeq: number | null | undefined,
): void {
  if (typeof lotSeq !== 'number' || !Number.isFinite(lotSeq)) return
  tx.update(purchases().doc(purchaseId), { lotSeq })
}

/**
 * RD-MC-REFUND-V2-P2 · What each named purchase's lot still holds.
 *
 * For the request and dashboard paths, which price a refund and must not open a transaction
 * to do it. ONE `getAll` for the whole page rather than a read per row — the refund view
 * renders 25 purchases at a time.
 *
 * A purchase missing from the result has no lot: not granted, or written before the backfill.
 * The caller decides what that means; this returns only what it can see, and never guesses.
 */
export async function readRemainingForPurchases(
  purchaseIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(purchaseIds)].filter(Boolean)
  const out = new Map<string, number>()
  if (ids.length === 0) return out

  const snaps = await adminDb.getAll(...ids.map(id => purchases().doc(id)))
  for (const snap of snaps) {
    if (!snap.exists) continue
    const doc = snap.data() as CreditPurchaseDoc
    if (doc.status !== 'granted') continue
    // Same backfill as every other read site: a document written before RD-MC-REFUND-V2-P1
    // has no `creditsRemaining`, and its credits are all still unspent by definition —
    // nothing could have drained a lot that did not exist.
    out.set(doc.purchaseId, doc.creditsRemaining ?? doc.credits)
  }
  return out
}

/** Σ remaining across EVERY open lot. For the invariant check; not on any hot path. */
export async function sumOpenLots(organizerUid: string): Promise<number> {
  const [pSnap, gSnap] = await Promise.all([
    purchases().where('organizerUid', '==', organizerUid).get(),
    grants().where('organizerUid', '==', organizerUid).get(),
  ])
  let total = 0
  for (const d of pSnap.docs) {
    const doc = d.data() as CreditPurchaseDoc
    if (doc.status !== 'granted') continue
    total += doc.creditsRemaining ?? doc.credits
  }
  for (const d of gSnap.docs) {
    const doc = d.data() as CreditGrantDoc
    total += doc.creditsRemaining ?? doc.credits
  }
  return total
}
