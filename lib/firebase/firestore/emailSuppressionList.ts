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
  // RD-LAUNCH-05 — optional SES feedback metadata. Present only on records created by
  // the SES/SNS webhook; unset for ordinary unsubscribes, so existing docs are valid.
  scope?:          'platform' | 'organizer'
  bounceType?:     string   // 'Permanent' | 'Transient' | 'Undetermined'
  bounceSubType?:  string   // 'General' | 'NoEmail' | 'Suppressed' | …
  complaintType?:  string   // 'abuse' | 'fraud' | 'not-spam' | …
  providerMessageId?: string
  feedbackId?:     string
  diagnostic?:     string   // SES diagnosticCode, truncated
  suppressedAt?:   string   // ISO timestamp reported by SES
}

/**
 * RD-LAUNCH-05 — the scope used for platform-wide suppression.
 *
 * A hard bounce or a spam complaint is a fact about the MAILBOX, not about one
 * organizer's relationship with it: an address that does not exist does not exist for
 * anyone, and SES feedback carries no organizer identity to attribute it to. Those
 * records are therefore written against this reserved scope and checked for every
 * send, whoever the sender is.
 *
 * Ordinary unsubscribes remain per-organizer — opting out of one organizer's mail must
 * not stop another organizer's ticket from arriving.
 *
 * Reusing one collection (rather than adding a second) keeps a single suppression
 * module, a single doc-ID scheme and a single check.
 */
export const PLATFORM_SCOPE = '__platform__'

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
 * RD-LAUNCH-05 — record a permanent SES failure against the PLATFORM scope.
 *
 * Idempotent by construction: the doc ID is deterministic, so AWS re-delivering the
 * same SNS notification (which it will) overwrites one record rather than creating a
 * second. `createdAt` is preserved on re-delivery via merge, so the first-seen time
 * survives and repeat notifications are visible as no-ops.
 */
export async function suppressEmailPlatformWide(
  email:  string,
  reason: 'bounce' | 'complaint',
  meta:   Omit<Partial<EmailSuppressionDoc>, 'email' | 'organizerUid' | 'reason' | 'createdAt'> = {},
): Promise<{ email: string; alreadySuppressed: boolean }> {
  const normalised = normaliseEmail(email)
  const ref  = col().doc(docId(PLATFORM_SCOPE, normalised))
  const snap = await ref.get()

  await ref.set(
    {
      email:        normalised,
      organizerUid: PLATFORM_SCOPE,
      scope:        'platform',
      reason,
      ...meta,
      // Only stamp on first write — a re-delivered notification must not reset it.
      ...(snap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
    },
    { merge: true },
  )

  return { email: normalised, alreadySuppressed: snap.exists }
}

/**
 * THE canonical suppression check, used before every outgoing email.
 *
 * Checks the platform scope first (hard bounces / complaints — nobody may send there),
 * then the organizer scope when one is supplied (that organizer's unsubscribes).
 */
export async function isSuppressed(
  email:         string,
  organizerUid?: string,
): Promise<boolean> {
  const normalised = normaliseEmail(email)
  if (!normalised) return false

  const refs = [col().doc(docId(PLATFORM_SCOPE, normalised))]
  if (organizerUid && organizerUid !== PLATFORM_SCOPE) {
    refs.push(col().doc(docId(organizerUid, normalised)))
  }

  // One batched read rather than one round trip per scope.
  const snaps = await adminDb.getAll(...refs)
  return snaps.some(s => s.exists)
}

/**
 * Returns the full set of suppressed emails (lowercase) for one organizer.
 * Used by the broadcast route to pre-filter all recipients in one Firestore read
 * rather than one read per recipient.
 */
export async function getOrganiserSuppressionSet(
  organizerUid: string,
): Promise<Set<string>> {
  // RD-LAUNCH-05: the union of this organizer's opt-outs AND every platform-wide
  // suppression. A hard-bounced address must be excluded from a broadcast even though
  // it never unsubscribed from this particular organizer.
  const [own, platform] = await Promise.all([
    col().where('organizerUid', '==', organizerUid).get(),
    col().where('organizerUid', '==', PLATFORM_SCOPE).get(),
  ])
  return new Set(
    [...own.docs, ...platform.docs].map(d => (d.data() as EmailSuppressionDoc).email),
  )
}
