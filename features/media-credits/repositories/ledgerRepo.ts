// MC-02 · Ledger persistence — SERVER ONLY. NO BUSINESS LOGIC.
//
// Firestore access for `mediaCreditLedger/{entryId}`. APPEND-ONLY: this file exposes no
// update and no delete, so immutability is a property of the API rather than a rule someone
// has to remember. Firestore rules deny every client path, so the Admin SDK through this
// repository is the only writer that exists.

import type { Transaction } from 'firebase-admin/firestore'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_LEDGER, MEDIA_CREDIT_SCHEMA_VERSION,
  type CreditLedgerEntryDoc, type CreditLedgerReason, type CreditActorKind,
} from '@/features/media-credits/types'

const ledger = () => adminDb.collection(MEDIA_CREDIT_LEDGER)

export const entryRef = (entryId: string) => ledger().doc(entryId)

/** Everything an entry needs that is not derived. `balanceAfter` is supplied by the caller. */
export interface AppendInput {
  entryId:       string
  organizerUid:  string
  delta:         number
  reason:        CreditLedgerReason
  balanceAfter:  number
  actorUid:      string
  actorKind:     CreditActorKind
  assetId?:       string | null
  reservationId?: string | null
  purchaseId?:    string | null
  refundId?:      string | null
  eventId?:       string | null
  eventSlug?:     string | null
}

/**
 * Transactional read — the read half of the idempotency guard.
 *
 * Returns the entry rather than a boolean so one read answers both questions a replay asks:
 * "has this already been applied" and "what balance did it leave". MC-09's grant record needs
 * the second, and the wallet cannot be re-read after the movement writes it.
 */
export async function readInTx(
  tx: Transaction, entryId: string,
): Promise<CreditLedgerEntryDoc | null> {
  const snap = await tx.get(entryRef(entryId))
  return snap.exists ? snap.data() as CreditLedgerEntryDoc : null
}

/**
 * Appends one entry.
 *
 * `tx.create` rather than `tx.set`: create FAILS if the document exists, so a replay that
 * slipped past the existence check — two transactions racing on the same entryId — is
 * rejected by Firestore instead of silently overwriting an immutable record.
 */
export function appendInTx(tx: Transaction, input: AppendInput): void {
  const doc: Omit<CreditLedgerEntryDoc, 'createdAt'> & { createdAt: unknown } = {
    entryId:       input.entryId,
    schemaVersion: MEDIA_CREDIT_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    delta:         input.delta,
    reason:        input.reason,
    balanceAfter:  input.balanceAfter,
    assetId:       input.assetId       ?? null,
    reservationId: input.reservationId ?? null,
    purchaseId:    input.purchaseId    ?? null,
    refundId:      input.refundId      ?? null,
    eventId:       input.eventId       ?? null,
    eventSlug:     input.eventSlug     ?? null,
    actorUid:      input.actorUid,
    actorKind:     input.actorKind,
    createdAt:     FieldValue.serverTimestamp(),
  }
  tx.create(entryRef(input.entryId), doc)
}

/** Newest-first page. Backed by the `organizerUid ASC, createdAt DESC` index from MC-01. */
export async function listByOrganizer(
  organizerUid: string, limit: number, cursorEntryId?: string | null,
): Promise<CreditLedgerEntryDoc[]> {
  let q = ledger()
    .where('organizerUid', '==', organizerUid)
    .orderBy('createdAt', 'desc')
    .limit(limit)

  if (cursorEntryId) {
    const cursorSnap = await entryRef(cursorEntryId).get()
    // Tenant-check the cursor before honouring it — the same defence `assetRepo.listAssets`
    // applies, so a forged cursor cannot page into another workspace's ledger.
    if (cursorSnap.exists && cursorSnap.get('organizerUid') === organizerUid) {
      q = q.startAfter(cursorSnap)
    }
  }
  const snap = await q.get()
  return snap.docs.map(d => d.data() as CreditLedgerEntryDoc)
}

/**
 * MC-08 · A bounded page of ledger entries across every workspace, optionally by reason.
 *
 * ADMIN-ONLY BY CALLER. The organizer-facing `listByOrganizer` is tenant-scoped; this
 * deliberately is not, because the operations console needs to answer "who has been granted
 * free credits" — a question that spans tenants by definition.
 *
 * Reason-filtered rather than fetch-everything-then-filter: grant history is a handful of
 * entries inside a ledger that grows with every settlement, and scanning the latter to find
 * the former would get slower every day the platform is used.
 */
export async function listPlatformWide(input: {
  limit:   number
  reason?: CreditLedgerReason
}): Promise<CreditLedgerEntryDoc[]> {
  let q: FirebaseFirestore.Query = ledger()
  if (input.reason) q = q.where('reason', '==', input.reason)
  const snap = await q.orderBy('createdAt', 'desc').limit(input.limit).get()
  return snap.docs.map(d => d.data() as CreditLedgerEntryDoc)
}
