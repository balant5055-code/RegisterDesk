// Attendee identity resolution — server-only.
// An attendee is identified by the email used during registration or donation.

import { adminDb } from '@/lib/firebase/admin'

/** Canonical email form used for lookups + storage (matches registration/submit). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Returns true if the normalized email appears as a registration attendee or a
 * donor. Single-equality queries (auto single-field index) — no composite index.
 */
export async function attendeeEmailExists(normalizedEmail: string): Promise<boolean> {
  const [regSnap, donSnap] = await Promise.all([
    adminDb.collection('registrations').where('attendee.email', '==', normalizedEmail).limit(1).get(),
    adminDb.collection('donations').where('donorEmail', '==', normalizedEmail).limit(1).get(),
  ])
  return !regSnap.empty || !donSnap.empty
}
