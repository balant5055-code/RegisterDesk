// MC-09 · Manual grant Firestore I/O — SERVER ONLY.
//
// NO BUSINESS LOGIC. This file knows how a grant is stored. It knows nothing about who may
// grant, how many credits are reasonable, or how the wallet moves — those live in
// grantService.ts and, for the balance itself, in the ledger's single writer.

import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_GRANTS, MEDIA_CREDIT_SCHEMA_VERSION,
  type CreditGrantDoc, type CreditGrantDto,
} from '@/features/media-credits/types'

const grants = () => adminDb.collection(MEDIA_CREDIT_GRANTS)

export function newGrantId(): string {
  return grants().doc().id
}

/**
 * The lot fields are omitted, not optional: a grant of N credits opens a lot of exactly N,
 * so letting a caller state a different number would create the drift the lots exist to
 * detect. They are derived below, from the same `credits` the ledger was told.
 */
export type CreateGrantInput =
  Omit<CreditGrantDoc, 'schemaVersion' | 'createdAt' | 'creditsRemaining' | 'lotSeq'>

/**
 * Appends the grant record INSIDE the caller's transaction.
 *
 * `tx.create`, never `tx.set`: a replayed grantId must FAIL the transaction rather than
 * overwrite the original record. That failure is the second half of the idempotency guard —
 * the ledger's `entryId` check short-circuits a replay first, and this backstops the race
 * where two requests with one id reach the transaction together.
 */
export function createInTx(tx: Transaction, input: CreateGrantInput): void {
  const doc: CreditGrantDoc = {
    ...input,
    schemaVersion: MEDIA_CREDIT_SCHEMA_VERSION,
    createdAt:     FieldValue.serverTimestamp(),

    // RD-MC-REFUND-V2-P1 · a grant is a lot too. Without this, Σ lots would fall short by
    // every credit ever granted and the invariant could not tell that from an attribution
    // bug. See utils/creditLots.ts.
    creditsRemaining: Math.max(0, Math.trunc(input.credits)),
    // Epoch millis, matching the purchase lot, so FIFO orders the two collections on one
    // scale. A grant made after a purchase is spent after it.
    lotSeq:           Date.now(),
  }
  tx.create(grants().doc(input.grantId), doc)
}

export async function readInTx(
  tx: Transaction, grantId: string,
): Promise<CreditGrantDoc | null> {
  const snap = await tx.get(grants().doc(grantId))
  return snap.exists ? snap.data() as CreditGrantDoc : null
}

export async function read(grantId: string): Promise<CreditGrantDoc | null> {
  const snap = await grants().doc(grantId).get()
  return snap.exists ? snap.data() as CreditGrantDoc : null
}

const toMs = (v: unknown): number =>
  v instanceof Timestamp ? v.toMillis()
    : v && typeof v === 'object' && 'toMillis' in v
      ? (v as { toMillis(): number }).toMillis()
      : 0

export function toDto(g: CreditGrantDoc): CreditGrantDto {
  return {
    grantId:      g.grantId,
    organizerUid: g.organizerUid,
    credits:      g.credits,
    reason:       g.reason,
    note:         g.note,
    reference:    g.reference,
    actorUid:     g.actorUid,
    entryId:      g.entryId,
    balanceAfter: g.balanceAfter,
    createdAtMs:  toMs(g.createdAt),
  }
}

export interface ListGrantsInput {
  /** Narrows to one workspace. Omitted, the query is platform-wide. */
  organizerUid?: string | null
  limit:         number
  /** The grantId to continue after. */
  cursor?:       string | null
}

/**
 * Newest first, cursor-paginated.
 *
 * Ordered by `createdAt`, so the cursor has to be resolved to its document — a `startAfter`
 * on an id alone would order by document name and interleave grants from different days.
 */
export async function list(
  input: ListGrantsInput,
): Promise<{ grants: CreditGrantDoc[]; nextCursor: string | null }> {
  const capped = Math.min(Math.max(1, Math.trunc(input.limit)), 200)

  let q = input.organizerUid
    ? grants().where('organizerUid', '==', input.organizerUid)
    : grants() as FirebaseFirestore.Query
  q = q.orderBy('createdAt', 'desc').limit(capped)

  if (input.cursor) {
    const anchor = await grants().doc(input.cursor).get()
    if (anchor.exists) q = q.startAfter(anchor)
  }

  const snap = await q.get()
  const rows = snap.docs.map(d => d.data() as CreditGrantDoc)
  return {
    grants:     rows,
    nextCursor: rows.length === capped ? rows[rows.length - 1].grantId : null,
  }
}

/** Platform-wide totals for the admin console. Bounded, and the caller is told when. */
export async function totals(limit = 1000): Promise<{
  count: number; credits: number; truncated: boolean
}> {
  const capped = Math.min(Math.max(1, Math.trunc(limit)), 5000)
  const snap = await grants().orderBy('createdAt', 'desc').limit(capped + 1).get()
  const rows = snap.docs.slice(0, capped).map(d => d.data() as CreditGrantDoc)
  return {
    count:   rows.length,
    // A corrupt field contributes nothing rather than making the whole total NaN.
    credits: rows.reduce((n, g) => n + (Number.isFinite(g.credits) ? g.credits : 0), 0),
    truncated: snap.docs.length > capped,
  }
}
