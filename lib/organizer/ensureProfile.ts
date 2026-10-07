// RD-AUTH-02 — Organizer Profile Integrity.
//
// The ONE canonical, idempotent guarantee that an authenticated organizer always
// has a canonical /users/{uid} document. Server-only (Admin SDK).
//
// Background: an Auth user can end up WITHOUT a Firestore profile (an orphaned
// signup whose profile write failed, or a legacy account). Firestore then holds a
// "phantom ancestor" — users/{uid}/eventDrafts + users/{uid}/notifications exist
// while the parent users/{uid} doc does not — and every profile-dependent read
// (dashboard identity, organizer notifications) silently misses.
//
// This is the single self-heal seam for the SESSION path. It is wired into the one
// endpoint every organizer session boots through — GET /api/organizer/dashboard —
// where it piggybacks the profile read that endpoint already performs, so the extra
// Firestore read/write happens ONLY in the rare missing-profile case. It complements
// (does not duplicate) the two existing creation paths, which stay authoritative for
// their moment:
//   • signup            → createOrganizerProfile (lib/firebase/firestore)
//   • email verification → verify-otp transaction self-heal (app/api/auth/verify-otp)
// This helper is the safety net for accounts that slipped past both.
//
// Firestore remains the canonical profile. Firebase Auth is the authoritative source
// for EMAIL IDENTITY ONLY — we read the Auth record purely to seed uid/name/email
// when reconstructing the missing doc. Never throws.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminAuth, adminDb }    from '@/lib/firebase/admin'
import { ORGANIZER_ROLE }        from '@/lib/organizer/identity'
import { isStaffEmail }          from '@/lib/staff/types'

// Mirrors app/api/auth/verify-otp EMAIL_VERIFIED_SCORE (20 base + 25 email). Kept in
// sync so a healed profile is byte-identical to what the canonical flows would write
// for the same verification state — the heal never invents a new trust shape.
const EMAIL_VERIFIED_SCORE = 45

/**
 * Guarantee /users/{uid} exists. Idempotent: returns the existing profile untouched
 * when present, otherwise creates the canonical document from the authoritative Auth
 * record (email identity only) and returns it. Returns the resolved profile data, or
 * null only if uid is empty or the write fails (never throws — callers stay best-effort).
 *
 * The verification/trust state is reflected from the Auth record's emailVerified flag
 * so the reconstructed profile matches the state the signup/verify-otp flows produce,
 * rather than resurrecting a verified organizer as unverified.
 */
export async function ensureOrganizerProfile(uid: string): Promise<Record<string, unknown> | null> {
  if (!uid) return null

  const ref = adminDb.collection('users').doc(uid)
  try {
    const snap = await ref.get()
    if (snap.exists) return snap.data() ?? {}

    // Missing profile — reconstruct from the authoritative Auth record (email identity).
    let email = ''
    let displayName = ''
    let authEmailVerified = false
    // RD-WORKSPACE-OWNERSHIP-01 · did we actually learn WHO this account is?
    //
    // This seam is the one profile-creation path a gate credential also reaches (staff
    // sign in, hit the dashboard, and their users doc is reconstructed here), so unlike
    // the other two it must not assert ownership blindly. When the Auth record is
    // unreadable the account is unidentifiable, and the marker is then left ABSENT rather
    // than guessed — a missing marker falls back to the legacy draft inference, i.e. to
    // exactly the behaviour that existed before this field.
    let authResolved = false
    try {
      const authUser = await adminAuth.getUser(uid)
      email             = authUser.email ?? ''
      displayName       = authUser.displayName ?? ''
      authEmailVerified = authUser.emailVerified
      authResolved      = true
    } catch (err) {
      // Auth record unexpectedly unavailable (e.g. deleted mid-session). Still create a
      // minimal identity shell so downstream reads/notifications resolve + log rather
      // than silently missing on a phantom ancestor.
      console.error('[ensureOrganizerProfile] auth lookup failed:', err)
    }

    const name = displayName || (email ? email.split('@')[0] : '')

    const profile: Record<string, unknown> = {
      uid,
      name,
      email,
      organizationName: '',
      role:             ORGANIZER_ROLE,
      // RD-WORKSPACE-OWNERSHIP-01 · explicit ownership, decided from the reserved staff
      // address namespace — the same unforgeable signal lib/team/access.ts derives
      // `isStaffCredential` from. A gate operator healed through this seam gets an explicit
      // `false`, which is what keeps them resolved into the workspace they were issued for
      // instead of their own empty one. Omitted entirely when the Auth record could not be
      // read (see authResolved) so an unidentifiable account inherits legacy behaviour.
      ...(authResolved ? { workspaceOwner: !isStaffEmail(email) } : {}),
      // RD-ORGANIZER-SIGNUP-02 · reflected from the same Auth flag as everything else
      // in this object, because this file's contract is that a healed profile is
      // byte-identical to what the canonical flows would write for the SAME
      // verification state — and those flows now carry accountStatus. In practice a
      // caller who reaches this seam is verified (it runs behind verifyCaller, which
      // refuses an unverified token), so this resolves to 'active'; mirroring the flag
      // rather than hard-coding it keeps the promise true if that ever changes.
      accountStatus:    authEmailVerified ? 'active' : 'pending',
      emailVerified:    authEmailVerified,
      verification: {
        email: {
          verified:       authEmailVerified,
          verifiedAt:     authEmailVerified ? FieldValue.serverTimestamp() : null,
          verifiedMethod: authEmailVerified ? 'auth' : null,
        },
      },
      trust: authEmailVerified
        ? { level: 'email_verified', score: EMAIL_VERIFIED_SCORE, badges: ['email'] }
        : { level: 'unverified',     score: 0,                    badges: [] },
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      // Provenance marker so the origin of a reconstructed profile is auditable.
      profileHealed:   true,
      profileHealedAt: FieldValue.serverTimestamp(),
    }

    // merge:true — converge with any concurrent writer (a racing verify-otp / a second
    // dashboard load) and safely re-parent the phantom-ancestor subcollections.
    await ref.set(profile, { merge: true })
    return profile
  } catch (err) {
    console.error('[ensureOrganizerProfile] failed:', err)
    return null
  }
}
