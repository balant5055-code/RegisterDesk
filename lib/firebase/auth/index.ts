import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
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

// ─── authenticateUser ─────────────────────────────────────────────────────────
// Neutral, role-agnostic credential sign-in — the SINGLE Firebase entry point
// shared by every login surface (organizer, admin, future support). Signs in
// with email/password, reloads the user so emailVerified/claims are fresh, and
// returns the authenticated user plus its verified state. Role validation and
// redirects are the caller's responsibility. Throws on auth failure.

export async function authenticateUser(
  email: string,
  password: string,
): Promise<{ user: User; emailVerified: boolean }> {
  const { user } = await signInWithEmailAndPassword(auth, email, password)
  await user.reload()
  return { user, emailVerified: auth.currentUser?.emailVerified ?? user.emailVerified }
}

// ─── signInOrganizer ──────────────────────────────────────────────────────────
// Organizer-facing wrapper over authenticateUser. Kept for backward
// compatibility — behavior is identical to before (returns emailVerified only).

export async function signInOrganizer(
  email: string,
  password: string,
): Promise<{ emailVerified: boolean }> {
  const { emailVerified } = await authenticateUser(email, password)
  return { emailVerified }
}

// ─── sendOrganizerPasswordReset ───────────────────────────────────────────────
// Sends a Firebase password-reset email. Swallows auth/user-not-found so
// callers can show the same "check your email" message without revealing
// whether the account exists.
// Throws for auth/invalid-email and auth/too-many-requests — mapAuthError handles both.

export async function sendOrganizerPasswordReset(email: string): Promise<void> {
  try {
    await sendPasswordResetEmail(auth, email)
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'auth/user-not-found') return
    throw err
  }
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
