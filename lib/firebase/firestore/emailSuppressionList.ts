// emailSuppressionList — per-organizer opt-out registry.
//
// Collection: emailSuppressionList
// Doc ID:     {organizerUid}_{normalised_email}   (deterministic → idempotent writes)
//
// Querying suppressed emails for a single organizer:
//   .where('organizerUid', '==', uid)  — requires no composite index (single-field)

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'

// ─── Document shape ───────────────────────────────────────────────────────────

export interface EmailSuppressionDoc {
  email:        string   // normalised to lowercase
  organizerUid: string
  reason:       string
  createdAt:    unknown  // Firestore Timestamp
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function normaliseEmail(email: string): string {
  return email.toLowerCase().trim()
}

// Deterministic doc ID — allows idempotent `set` without collision risk.
// Replaces characters that would need escaping in Firestore paths.
function docId(organizerUid: string, email: string): string {
  const safe = normaliseEmail(email).replace(/[^a-z0-9@._-]/g, '_')
  return `${organizerUid}_${safe}`
}

function col() {
  return adminDb.collection('emailSuppressionList')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Adds email to an organizer's suppression list. Idempotent. */
export async function addToSuppressionList(
  email:        string,
  organizerUid: string,
  reason:       string = 'unsubscribe',
): Promise<void> {
  const doc: EmailSuppressionDoc = {
    email:        normaliseEmail(email),
    organizerUid,
    reason,
    createdAt:    FieldValue.serverTimestamp(),
  }
  // set without merge — always writes the canonical record
  await col().doc(docId(organizerUid, email)).set(doc)
}

/** Returns true if this email is on the organizer's suppression list. */
export async function isEmailSuppressed(
  email:        string,
  organizerUid: string,
): Promise<boolean> {
  const snap = await col().doc(docId(organizerUid, email)).get()
  return snap.exists
}

/**
 * Returns the full set of suppressed emails (lowercase) for one organizer.
 * Used by the broadcast route to pre-filter all recipients in one Firestore read
 * rather than one read per recipient.
 */
export async function getOrganiserSuppressionSet(
  organizerUid: string,
): Promise<Set<string>> {
  const snap = await col()
    .where('organizerUid', '==', organizerUid)
    .get()
  return new Set(
    snap.docs.map(d => (d.data() as EmailSuppressionDoc).email),
  )
}
