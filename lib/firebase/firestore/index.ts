import {
  getFirestore,
  doc,
  setDoc,
  serverTimestamp,
} from 'firebase/firestore'
import { firebaseApp } from '../config'

export const db = getFirestore(firebaseApp)

// ─── createOrganizerProfile ───────────────────────────────────────────────────
// Writes the initial organizer document to /organizers/{uid}.
// Called immediately after Firebase Auth user creation.

export async function createOrganizerProfile(
  uid: string,
  data: {
    name:             string
    email:            string
    organizationName: string
  },
): Promise<void> {
  await setDoc(doc(db, 'users', uid), {
    uid,
    name:             data.name,
    email:            data.email,
    organizationName: data.organizationName,
    role:             'organizer',
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
