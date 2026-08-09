// MC-03 · Reservation persistence — SERVER ONLY. NO BUSINESS LOGIC.
//
// Firestore access for `mediaCreditReservations/{assetId}`. The document id IS the assetId
// (MC-01 Decision 2): a hold is looked up by key from both the upload path and the sweep,
// with no query and no index, and two holds for one asset are unrepresentable rather than
// merely unlikely.
//
// Every write here is transaction-scoped. There is no standalone write, because a hold and
// the wallet figure it affects must always move together.

import type { Transaction } from 'firebase-admin/firestore'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  MEDIA_CREDIT_RESERVATIONS, MEDIA_CREDIT_SCHEMA_VERSION,
  type CreditReservationDoc, type CreditReservationStatus,
} from '@/features/media-credits/types'

const reservations = () => adminDb.collection(MEDIA_CREDIT_RESERVATIONS)

export const reservationRef = (assetId: string) => reservations().doc(assetId)

export async function read(assetId: string): Promise<CreditReservationDoc | null> {
  const snap = await reservationRef(assetId).get()
  return snap.exists ? (snap.data() as CreditReservationDoc) : null
}

export async function readInTx(
  tx: Transaction, assetId: string,
): Promise<CreditReservationDoc | null> {
  const snap = await tx.get(reservationRef(assetId))
  return snap.exists ? (snap.data() as CreditReservationDoc) : null
}

export interface CreateInput {
  assetId:      string
  organizerUid: string
  eventId:      string
  eventSlug:    string
  galleryId:    string
  credits:      number
  /** MC-06B: the session whose allocation authorises this slot. */
  sessionId:    string
  /** MC-06B: position within that session. */
  slotIndex:    number
}

/**
 * Creates a `held` reservation.
 *
 * `tx.create` rather than `tx.set`: create FAILS if the document exists, so two transactions
 * racing on one assetId cannot both place a hold. The service's existence check handles the
 * ordinary replay; this is the backstop for the race the check cannot see.
 */
export function createInTx(tx: Transaction, input: CreateInput): void {
  const doc: CreditReservationDoc = {
    reservationId: input.assetId,
    schemaVersion: MEDIA_CREDIT_SCHEMA_VERSION,
    organizerUid:  input.organizerUid,
    eventId:       input.eventId,
    eventSlug:     input.eventSlug,
    galleryId:     input.galleryId,
    credits:       input.credits,
    sessionId:     input.sessionId,
    slotIndex:     input.slotIndex,
    status:        'held',
    createdAt:     FieldValue.serverTimestamp(),
    resolvedAt:    null,
  }
  tx.create(reservationRef(input.assetId), doc)
}

/** Moves a reservation to a terminal state. Only ever called on a `held` record. */
export function resolveInTx(
  tx: Transaction, assetId: string, status: Exclude<CreditReservationStatus, 'held'>,
): void {
  tx.update(reservationRef(assetId), {
    status,
    resolvedAt: FieldValue.serverTimestamp(),
  })
}

/**
 * Holds older than the cutoff, oldest first.
 *
 * Backed by the `status ASC, createdAt ASC` index from MC-01 — the same shape the media
 * reclamation sweep uses on `mediaAssets`.
 */
export async function listStaleHeld(
  olderThanMs: number, limit: number,
): Promise<CreditReservationDoc[]> {
  const cutoff = Timestamp.fromMillis(Date.now() - olderThanMs)
  const snap = await reservations()
    .where('status', '==', 'held')
    .where('createdAt', '<=', cutoff)
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get()
  return snap.docs.map(d => d.data() as CreditReservationDoc)
}

/**
 * MC-06C · How many slots of a session were actually used.
 *
 * Counts ONLY `consumed` reservations. `held` (claimed but never completed), `released`
 * (failed or swept) and absent (never claimed) all count as zero — an organizer pays for
 * photos that landed, nothing else.
 *
 * Uses a server-side aggregation rather than reading the documents: a 10,000-slot session
 * would otherwise cost 10,000 document reads to answer one number.
 *
 * DETERMINISTIC ONLY ON A SEALED SESSION. Nothing bars consumption while a session is
 * ACTIVE, so a count taken then is a sample, not a total. Settlement seals first for exactly
 * this reason (Spec v1.0 §6, §10).
 */
export async function countConsumedBySession(sessionId: string): Promise<number> {
  const snap = await reservations()
    .where('sessionId', '==', sessionId)
    .where('status', '==', 'consumed')
    .count()
    .get()
  return snap.data().count
}
