// RD-AUTH-02 — Organizer email identity resolution.
//
// The ONE canonical resolver for "given an organizer uid, what email do we notify?"
// Server-only (Admin SDK). Firestore /users/{uid} is the canonical profile and the
// preferred source; Firebase Auth is the AUTHORITATIVE FALLBACK FOR EMAIL IDENTITY
// ONLY, used when the profile doc is missing (a phantom ancestor) or carries no email.
//
// This exists so the notification layer no longer depends SOLELY on Firestore: a
// missing profile must not make an organizer email silently unreachable. Never throws.

import { adminAuth, adminDb } from '@/lib/firebase/admin'

export type OrganizerEmailSource = 'firestore' | 'auth' | 'none'

export interface OrganizerEmailIdentity {
  /** The organizer's email, or '' when it cannot be resolved from either source. */
  email:  string
  /** Best-known display name (Firestore name → Auth displayName), or ''. */
  name:   string
  /** Where `email` came from — for observability in skip/send logs. */
  source: OrganizerEmailSource
}

/**
 * Resolve an organizer's notification email. Reads the canonical Firestore profile
 * first; on a missing doc or empty email, falls back to the authoritative Firebase
 * Auth record's email (identity only — role/trust are never sourced from Auth).
 * Never throws — on total failure returns { email: '', source: 'none' }.
 */
export async function resolveOrganizerEmailIdentity(uid: string): Promise<OrganizerEmailIdentity> {
  if (!uid) return { email: '', name: '', source: 'none' }

  let fsName = ''
  try {
    const snap = await adminDb.collection('users').doc(uid).get()
    if (snap.exists) {
      const d = snap.data() as { email?: unknown; name?: unknown }
      fsName = typeof d.name === 'string' ? d.name : ''
      if (typeof d.email === 'string' && d.email.trim()) {
        return { email: d.email, name: fsName, source: 'firestore' }
      }
    }
  } catch (err) {
    console.error('[resolveOrganizerEmailIdentity] firestore read failed:', err)
  }

  // Firestore doc missing or email absent → authoritative Auth fallback (email only).
  try {
    const authUser = await adminAuth.getUser(uid)
    if (authUser.email && authUser.email.trim()) {
      return { email: authUser.email, name: fsName || authUser.displayName || '', source: 'auth' }
    }
  } catch (err) {
    console.error('[resolveOrganizerEmailIdentity] auth lookup failed:', err)
  }

  return { email: '', name: fsName, source: 'none' }
}
