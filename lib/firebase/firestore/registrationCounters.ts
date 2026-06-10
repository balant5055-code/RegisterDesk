// Server-only: Firebase Admin SDK.

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import type { RegistrationCounter } from '@/lib/registrations/types'

const col = () => adminDb.collection('registrationCounters')

// ─── Reads ────────────────────────────────────────────────────────────────────

/**
 * Returns the live registration counter for an event.
 * Returns null (not 0) when no registrations have occurred yet — callers must
 * treat null as all-zero to distinguish "no document" from "exists but broken".
 */
export async function getRegistrationCounter(
  eventSlug: string,
): Promise<RegistrationCounter | null> {
  const snap = await col().doc(eventSlug).get()
  if (!snap.exists) return null
  return snap.data() as RegistrationCounter
}

// ─── Writes (used inside registration transaction) ────────────────────────────

/**
 * Returns a plain object suitable for use inside a Firestore transaction or
 * batch write to atomically increment both the total count and pass-specific count.
 *
 * Usage inside a transaction:
 *   txn.set(counterRef, buildCounterIncrement(eventSlug, passId), { merge: true })
 */
export function buildCounterIncrement(
  eventSlug: string,
  passId:    string,
): Record<string, unknown> {
  return {
    eventSlug,
    totalCount:                FieldValue.increment(1),
    [`passCounts.${passId}`]:  FieldValue.increment(1),
    updatedAt:                 FieldValue.serverTimestamp(),
  }
}

/**
 * Ensures a zero-valued counter document exists for an event.
 * Called once during publish — idempotent via set+merge.
 * Pre-creating the document avoids a missing-document edge case during the
 * first registration transaction.
 */
export async function ensureCounterExists(eventSlug: string): Promise<void> {
  await col().doc(eventSlug).set(
    {
      eventSlug,
      totalCount: 0,
      passCounts: {},
      updatedAt:  FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}

/**
 * Decrement helper — used when a registration is cancelled.
 * Never decrements below 0 via max(0, current - 1) enforced by the caller.
 */
export function buildCounterDecrement(passId: string): Record<string, unknown> {
  return {
    totalCount:                FieldValue.increment(-1),
    [`passCounts.${passId}`]:  FieldValue.increment(-1),
    updatedAt:                 FieldValue.serverTimestamp(),
  }
}
