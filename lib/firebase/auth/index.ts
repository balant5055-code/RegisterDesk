import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  connectAuthEmulator,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { firebaseApp } from '../config'
import { connectOnce, EMULATOR_HOST, EMULATOR_PORTS } from '../emulator'
import { createOrganizerProfile, organizerProfileExists } from '../firestore'

export const auth = getAuth(firebaseApp)

// RD-EVENT-16 — no-op unless NEXT_PUBLIC_FIREBASE_EMULATOR === 'true'. Must run before any
// sign-in call, which module scope guarantees.
connectOnce('auth', () =>
  connectAuthEmulator(auth, `http://${EMULATOR_HOST}:${EMULATOR_PORTS.auth}`, { disableWarnings: true }))

// ─── applySessionPersistence ──────────────────────────────────────────────────
// The SINGLE session-persistence decision (RD-AUTH-01 H-B). This is the ONLY place
// persistence is selected — every login path routes through authenticateUser below,
// which awaits this before signing in, so the credential is stored with the chosen
// scope. Remember Me = true keeps the session across browser restarts
// (browserLocalPersistence, shared across tabs); false scopes it to the current
// tab/session (browserSessionPersistence, cleared when the browser/tab closes).
// Firebase's own default (local) still governs restoration of a pre-existing session
// on page load, so returning users are unaffected until they next sign in.
async function applySessionPersistence(remember: boolean): Promise<void> {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence)
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SignupData {
  name:    string
  email:   string
  password: string
  orgName: string
  // RD-AUTH-02 Phase 2: PRIVATE organizer account mobile, collected at signup.
  // `mobileE164` is the canonical '+…' form; `mobileCountryCode` is the dial code
  // (e.g. '+91'). Stored on the Organizer Account, never on the Organization Profile.
  mobileE164:        string
  mobileCountryCode: string
}

// ─── createOrganizerAccount ───────────────────────────────────────────────────
// Canonical, idempotent signup:
//   1. Create the Firebase Auth user
//   2. Set displayName on the Auth profile
//   3. Create the Firestore organizer profile (/users/{uid})
//
// Failure atomicity (RD-AUTH-01 H-A). If step 1 succeeds but step 2/3 fails
// (Firestore outage, timeout, transient permission error), the Auth user is left
// WITHOUT a profile — an "orphaned" account. Firebase then rejects a second create
// for that email (auth/email-already-in-use), which previously stranded the user
// permanently. This flow is now self-healing: on auth/email-already-in-use it
// re-authenticates with the same credentials and, IF the profile is genuinely
// missing, completes it with the retry's form data (organizationName preserved).
// A complete, pre-existing account is left untouched and surfaces "sign in instead"
// exactly as before. One flow, one profile-creation call (createOrganizerProfile),
// one recovery path — no Auth-user deletion (client cleanup can't be guaranteed;
// complete-on-retry matches the existing server-side verify-otp self-heal).
//
// Verification is handled separately via OTP — no email link is sent here.
// Throws on any unrecoverable failure — caller maps it via mapAuthError.

export async function createOrganizerAccount(data: SignupData): Promise<void> {
  let user: User
  try {
    const cred = await createUserWithEmailAndPassword(auth, data.email, data.password)
    user = cred.user
  } catch (err) {
    // The one recoverable Auth error: the account already exists. It's either an
    // orphaned signup (recoverable) or a real duplicate (not) — recoverOrphanedSignup
    // decides. Any other error, or an unrecoverable duplicate, rethrows unchanged.
    if (err instanceof FirebaseError && err.code === 'auth/email-already-in-use') {
      const recovered = await recoverOrphanedSignup(data)
      if (recovered) return
    }
    throw err
  }

  // New Auth user → finish the canonical profile.
  await completeOrganizerProfile(user, data)
}

// The SINGLE organizer/profile-creation path — shared by the happy path and orphan
// recovery so there is exactly one profile shape. Sets displayName, then writes the
// canonical /users/{uid} document via createOrganizerProfile.
async function completeOrganizerProfile(user: User, data: SignupData): Promise<void> {
  await updateProfile(user, { displayName: data.name })
  await createOrganizerProfile(user.uid, {
    name:              data.name,
    email:             user.email ?? data.email,
    organizationName:  data.orgName,
    mobileE164:        data.mobileE164,
    mobileCountryCode: data.mobileCountryCode,
  })
}

// Recovery for an orphaned signup (Auth user exists, profile write never completed).
// Returns TRUE when it fully recovered: the account had no profile, so it was created
// with the retry's data and the user is left signed in (the caller then requests the
// verification OTP, as on a fresh signup). Returns FALSE when the email belongs to a
// real, complete account or the password doesn't match — the caller rethrows
// auth/email-already-in-use ("sign in instead"), preserving the original UX.
async function recoverOrphanedSignup(data: SignupData): Promise<boolean> {
  let user: User
  try {
    const cred = await signInWithEmailAndPassword(auth, data.email, data.password)
    user = cred.user
  } catch {
    // Wrong password / disabled account → not an orphan this caller can recover.
    return false
  }

  if (await organizerProfileExists(user.uid)) {
    // A complete account already exists → genuine duplicate, not an orphan. Restore the
    // pre-attempt signed-out state so the caller's "sign in instead" message is truthful.
    await signOut(auth).catch(() => {})
    return false
  }

  // Orphaned Auth account with no profile → complete it now (organizationName preserved).
  await completeOrganizerProfile(user, data)
  return true
}

// ─── authenticateUser ─────────────────────────────────────────────────────────
// Neutral, role-agnostic credential sign-in — the SINGLE Firebase entry point
// shared by every login surface (organizer, admin, future support). Applies the
// canonical session-persistence decision (Remember Me) BEFORE signing in, then signs
// in with email/password, reloads the user so emailVerified/claims are fresh, and
// returns the authenticated user plus its verified state. Role validation and
// redirects are the caller's responsibility. Throws on auth failure.
//
// `remember` defaults to true so callers that don't surface a Remember Me control
// (e.g. admin login) keep the prior persist-across-restarts behavior unchanged.

export async function authenticateUser(
  email: string,
  password: string,
  remember: boolean = true,
): Promise<{ user: User; emailVerified: boolean }> {
  await applySessionPersistence(remember)
  const { user } = await signInWithEmailAndPassword(auth, email, password)
  await user.reload()
  return { user, emailVerified: auth.currentUser?.emailVerified ?? user.emailVerified }
}

// ─── signInOrganizer ──────────────────────────────────────────────────────────
// Organizer-facing wrapper over authenticateUser. Forwards the caller's Remember Me
// choice to the single persistence decision above; returns emailVerified only.

export async function signInOrganizer(
  email: string,
  password: string,
  remember: boolean = true,
): Promise<{ emailVerified: boolean }> {
  const { emailVerified } = await authenticateUser(email, password, remember)
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
      // ── Social / OAuth (RD-AUTH-02 Phases 7–9) ───────────────────────────────
      case 'auth/operation-not-allowed':
        return 'This sign-in method isn’t enabled yet. Please use email and password.'
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
        return 'Sign-in was cancelled.'
      case 'auth/popup-blocked':
        return 'Your browser blocked the sign-in popup. Allow popups and try again.'
      case 'auth/account-exists-with-different-credential':
        return 'An account already exists with this email. Sign in with your original method to link it.'
      default:
        return 'Something went wrong. Please try again.'
    }
  }
  return 'Something went wrong. Please try again.'
}
