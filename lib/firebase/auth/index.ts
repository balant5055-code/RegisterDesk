import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithEmailAndPassword,
} from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { firebaseApp } from '../config'
import { createOrganizerProfile } from '../firestore'

export const auth = getAuth(firebaseApp)

// Persist the session across browser restarts (not just the current tab).
// Fire-and-forget: queued operations wait until persistence is set.
setPersistence(auth, browserLocalPersistence).catch(console.error)

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignupData {
  name:    string
  email:   string
  password: string
  orgName: string
}

// ─── createOrganizerAccount ───────────────────────────────────────────────────
// 1. Create Firebase Auth user
// 2. Set displayName on the Firebase Auth profile
// 3. Create Firestore organizer profile
// Verification is handled separately via OTP — no email link is sent here.
// Throws on any failure — caller handles the error message.

export async function createOrganizerAccount(data: SignupData): Promise<void> {
  const { user } = await createUserWithEmailAndPassword(auth, data.email, data.password)
  await updateProfile(user, { displayName: data.name })
  await createOrganizerProfile(user.uid, {
    name:             data.name,
    email:            user.email ?? data.email,
    organizationName: data.orgName,
  })
}

// ─── signInOrganizer ──────────────────────────────────────────────────────────
// Signs in with email/password, reloads the user to get the latest emailVerified
// state from Firebase, then returns whether the email is verified.
// Throws on auth failure — caller handles the error message.

export async function signInOrganizer(
  email: string,
  password: string,
): Promise<{ emailVerified: boolean }> {
  const { user } = await signInWithEmailAndPassword(auth, email, password)
  await user.reload()
  return { emailVerified: auth.currentUser?.emailVerified ?? user.emailVerified }
}

// ─── mapAuthError ─────────────────────────────────────────────────────────────
// Maps Firebase Auth error codes to short, user-facing strings.

export function mapAuthError(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
      case 'auth/email-already-in-use':
        return 'An account with this email already exists. Sign in instead.'
      case 'auth/invalid-email':
        return 'Please enter a valid email address.'
      case 'auth/weak-password':
        return 'Password must be at least 6 characters.'
      case 'auth/user-not-found':
      case 'auth/wrong-password':
      case 'auth/invalid-credential':
        return 'Incorrect email or password.'
      case 'auth/user-disabled':
        return 'This account has been disabled. Please contact support.'
      case 'auth/expired-action-code':
        return 'This verification link has expired. Please request a new one.'
      case 'auth/invalid-action-code':
        return 'This verification link has already been used or is invalid.'
      case 'auth/network-request-failed':
        return 'Network error. Check your connection and try again.'
      case 'auth/too-many-requests':
        return 'Too many attempts. Please wait a moment and try again.'
      default:
        return 'Something went wrong. Please try again.'
    }
  }
  return 'Something went wrong. Please try again.'
}
