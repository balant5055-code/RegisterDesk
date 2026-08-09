import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp,
  connectFirestoreEmulator,
} from 'firebase/firestore'
import { firebaseApp } from '../config'
import { connectOnce, EMULATOR_HOST, EMULATOR_PORTS } from '../emulator'
import { ORGANIZER_ROLE } from '@/lib/organizer/identity'

export const db = getFirestore(firebaseApp)

// RD-EVENT-16 — no-op unless the emulator flag is set. Must run before the first read.
connectOnce('firestore', () => connectFirestoreEmulator(db, EMULATOR_HOST, EMULATOR_PORTS.firestore))

// ─── organizerProfileExists ───────────────────────────────────────────────────
// True when the canonical /users/{uid} profile doc already exists. Used by the
// signup recovery path (RD-AUTH-01 H-A) to tell an ORPHANED Auth account (Auth user
// created, but the profile write never completed) apart from a genuinely complete,
// pre-existing account. Reads only the owner's own doc (allowed by firestore.rules).

export async function organizerProfileExists(uid: string): Promise<boolean> {
  const snap = await getDoc(doc(db, 'users', uid))
  return snap.exists()
}

// ─── createOrganizerProfile ───────────────────────────────────────────────────
// Writes the initial organizer document to /users/{uid} (the one canonical identity
// doc — there is no separate /organizers collection).
// Called immediately after Firebase Auth user creation.

export async function createOrganizerProfile(
  uid: string,
  data: {
    name:             string
    email:            string
    organizationName: string
    // RD-AUTH-02 Phase 1: the PRIVATE organizer account mobile — the canonical
    // destination for RegisterDesk platform notifications (WhatsApp/SMS, security,
    // recovery). This is NOT organizationProfile.supportPhone (public/attendee-facing)
    // and NOT eventDetails.organizer.phone. Optional so social sign-ups and legacy
    // callers that don't collect it still create a valid profile (backward-compatible).
    mobileE164?:        string
    mobileCountryCode?: string
  },
): Promise<void> {
  await setDoc(doc(db, 'users', uid), {
    uid,
    name:             data.name,
    email:            data.email,
    organizationName: data.organizationName,
    // Account-level (PRIVATE) contact. `verified` is false until phone OTP lands
    // (RD-AUTH-02 leaves the architecture ready; no OTP is introduced yet).
    mobile: {
      e164:        data.mobileE164 ?? '',
      countryCode: data.mobileCountryCode ?? '',
      verified:    false,
      verifiedAt:  null,
    },
    role:             ORGANIZER_ROLE,
    emailVerified:    false,
    verification: {
      email: {
        verified:        false,
        verifiedAt:      null,
        verifiedMethod:  null,
      },
    },
    trust: {
      level:  'unverified',
      score:  0,
      badges: [],
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}
