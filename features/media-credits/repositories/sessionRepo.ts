// MC-06A · Session Firestore I/O — SERVER ONLY.
//
// NO BUSINESS LOGIC. This file knows how a session is stored. It knows nothing about whether
// an organizer may open one, whether they can afford it, or what a slot costs — those live in
// sessionService.ts. A repository that "helpfully" defaulted an allocation would become a
// second place credit amounts come from.
//
// ═══ WRITE FREQUENCY IS THE POINT ════════════════════════════════════════════
// A session document is written exactly twice in its life (open, settle), plus once to seal.
// NEVER per photo. Any method added here that a per-photo path would call is a design
// violation, not a convenience — see Architecture Spec v1.0 §3 P3.

import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_SESSIONS, MEDIA_CREDIT_SCHEMA_VERSION,
  type CreditSessionDoc, type CreditSessionSealReason, type CreditSessionStatus,
} from '@/features/media-credits/types'

const sessions = () => adminDb.collection(MEDIA_CREDIT_SESSIONS)

export const sessionRef = (sessionId: string) => sessions().doc(sessionId)

export interface CreateSessionInput {
  sessionId:             string
  organizerUid:          string
  eventId:               string
  eventSlug:             string
  galleryId:             string
  allocatedCredits:      number
  slotCount:             number
  creditsPerPhotoAtOpen: number
  expiresAt:             Date
}

/**
 * Creates the session INSIDE the caller's transaction.
 *
 * `tx.create`, never `tx.set`: a duplicate sessionId must fail loudly rather than silently
 * overwrite an allocation that may already be holding credits. This is the entire mechanism
 * behind idempotent open (Spec §17) — the caller supplies the id, so a retry collides here
 * instead of placing a second hold.
 */
export function createInTx(tx: Transaction, input: CreateSessionInput): CreditSessionDoc {
  const doc: CreditSessionDoc = {
    sessionId:     input.sessionId,
    schemaVersion: MEDIA_CREDIT_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    eventId:       input.eventId,
    eventSlug:     input.eventSlug,
    galleryId:     input.galleryId,

    allocatedCredits:      input.allocatedCredits,
    slotCount:             input.slotCount,
    creditsPerPhotoAtOpen: input.creditsPerPhotoAtOpen,

    status:     'ACTIVE',
    sealReason: null,
    sealedBy:   null,

    consumedSlots:     null,
    settlementEntryId: null,

    settlementAttempts: 0,
    quarantined:        false,
    quarantinedAt:      null,

    openedAt:  FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(input.expiresAt),
    sealedAt:  null,
    settledAt: null,
  }
  tx.create(sessionRef(input.sessionId), doc)
  return doc
}

export async function read(sessionId: string): Promise<CreditSessionDoc | null> {
  const snap = await sessionRef(sessionId).get()
  return snap.exists ? (snap.data() as CreditSessionDoc) : null
}

/**
 * Reads the session INSIDE the caller's transaction.
 *
 * MC-06B's upload path will call this from within `registerAsset`'s transaction, and that
 * placement is load-bearing rather than stylistic: because the transaction READ this
 * document, a seal committing first aborts it. That is the seal barrier (Spec §6) — it is
 * what makes the settlement count exact. Moving this read outside a transaction silently
 * destroys the guarantee.
 */
export async function readInTx(
  tx: Transaction, sessionId: string,
): Promise<CreditSessionDoc | null> {
  const snap = await tx.get(sessionRef(sessionId))
  return snap.exists ? (snap.data() as CreditSessionDoc) : null
}

/** Marks a session sealed inside the caller's transaction. Pure write — must follow reads. */
export function sealInTx(
  tx: Transaction, sessionId: string,
  reason: CreditSessionSealReason, sealedBy: string,
): void {
  tx.update(sessionRef(sessionId), {
    status:     'SEALED' satisfies CreditSessionStatus,
    sealReason: reason,
    sealedBy,
    sealedAt:   FieldValue.serverTimestamp(),
  })
}

/**
 * MC-06C · Marks a session settled INSIDE the caller's transaction.
 *
 * Records the count it was settled on and the ledger entry that carries the charge, so the
 * document explains its own settlement without a join. Pure write — must follow every read.
 */
export function markSettledInTx(
  tx: Transaction, sessionId: string,
  consumedSlots: number, settlementEntryId: string | null,
): void {
  tx.update(sessionRef(sessionId), {
    status:    'SETTLED' satisfies CreditSessionStatus,
    consumedSlots,
    settlementEntryId,
    settledAt: FieldValue.serverTimestamp(),
  })
}

/**
 * ACTIVE sessions past their expiry, oldest first.
 *
 * Ordered ascending so a backlog drains in the order it accumulated rather than starving the
 * oldest — those are the ones whose credits have been held longest.
 */
export async function listExpiredActive(limit: number): Promise<CreditSessionDoc[]> {
  const snap = await sessions()
    .where('status', '==', 'ACTIVE')
    .where('expiresAt', '<=', Timestamp.now())
    .orderBy('expiresAt', 'asc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as CreditSessionDoc)
}

/** Sessions awaiting settlement. MC-06B/C consume this; nothing settles in MC-06A. */
export async function listSealed(limit: number): Promise<CreditSessionDoc[]> {
  const snap = await sessions()
    .where('status', '==', 'SEALED')
    // MC-06F: quarantined sessions are excluded, not merely skipped in the loop. `listSealed`
    // is ordered oldest-first, so a permanently-failing session left in the result set would
    // occupy the head of the queue every pass and starve everything behind it — a poison pill
    // that delays settlement for every other organizer. Measured for real in MC-06E.
    .where('quarantined', '==', false)
    .orderBy('sealedAt', 'asc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as CreditSessionDoc)
}

/** Sessions removed from the settlement queue. For the operator, not the scheduler. */
export async function listQuarantined(limit: number): Promise<CreditSessionDoc[]> {
  const snap = await sessions()
    .where('quarantined', '==', true)
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as CreditSessionDoc)
}

export async function countQuarantined(): Promise<number> {
  const snap = await sessions().where('quarantined', '==', true).count().get()
  return snap.data().count
}

/**
 * Records a failed settlement attempt, quarantining once the threshold is reached.
 *
 * Outside any transaction: this is bookkeeping about a failure that already happened, and
 * making it transactional would tie it to the very transaction that just failed.
 */
export async function recordSettlementFailure(
  sessionId: string, attempts: number, quarantine: boolean,
): Promise<void> {
  await sessionRef(sessionId).update({
    settlementAttempts: attempts,
    ...(quarantine ? { quarantined: true, quarantinedAt: FieldValue.serverTimestamp() } : {}),
  })
}

/**
 * One organizer's sessions, newest first. Cursor is tenant-checked before use, so a caller
 * cannot page from another workspace's sessionId.
 */
export async function listByOrganizer(
  organizerUid: string, limit: number, cursor?: string | null,
): Promise<CreditSessionDoc[]> {
  let q = sessions()
    .where('organizerUid', '==', organizerUid)
    .orderBy('openedAt', 'desc')
    .limit(limit)

  if (cursor) {
    const after = await sessionRef(cursor).get()
    if (after.exists && (after.data() as CreditSessionDoc).organizerUid === organizerUid) {
      q = q.startAfter(after)
    }
  }
  const snap = await q.get()
  return snap.docs.map(d => d.data() as CreditSessionDoc)
}

// ─── Operational metrics (MC-06D) ─────────────────────────────────────────────

/**
 * How many sessions sit in one status.
 *
 * Server-side aggregation rather than a document read: these are dashboard numbers and must
 * not cost one read per session to answer.
 */
export async function countByStatus(status: CreditSessionStatus): Promise<number> {
  const snap = await sessions().where('status', '==', status).count().get()
  return snap.data().count
}

/**
 * ACTIVE sessions already past their expiry — the backlog the sweep has yet to reach.
 *
 * A number that only grows is the clearest signal the scheduler has stopped running, which is
 * why it is surfaced separately from the plain ACTIVE count.
 */
export async function countExpiredActive(): Promise<number> {
  const snap = await sessions()
    .where('status', '==', 'ACTIVE')
    .where('expiresAt', '<=', Timestamp.now())
    .count()
    .get()
  return snap.data().count
}
