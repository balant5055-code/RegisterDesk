// RD-AUTH-02 Phases 7–9 — Social sign-in (Google, Microsoft, Facebook) with
// production-safe account linking and duplicate-account prevention.
//
// ONE generic implementation drives all three providers (no per-provider copy). The
// organizer identity stays keyed on a SINGLE Firebase uid: when a social credential
// collides with an email that already has another sign-in method, Firebase raises
// `auth/account-exists-with-different-credential`; we resolve the existing method via
// fetchSignInMethodsForEmail and LINK the new credential onto the existing account
// (linkWithCredential) instead of creating a second account. The Firestore organizer
// profile is created — if missing — by the existing idempotent server seam
// (ensureOrganizerProfile at dashboard boot), so no new profile-creation path is
// introduced and no duplicate /users/{uid} document can be produced.
//
// DEPLOYMENT PREREQUISITES (outside code): each provider must be enabled in the
// Firebase console with its OAuth client id/secret, and the project's
// "one account per email" setting kept ON. Until a provider is enabled its button
// will surface auth/operation-not-allowed, which mapAuthError already handles.

import {
  GoogleAuthProvider,
  FacebookAuthProvider,
  OAuthProvider,
  signInWithPopup,
  fetchSignInMethodsForEmail,
  linkWithCredential,
  signInWithEmailAndPassword,
  setPersistence,
  browserLocalPersistence,
} from 'firebase/auth'
import type { AuthCredential, AuthProvider, User } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { auth } from './index'

// ─── Provider registry ────────────────────────────────────────────────────────

export type SocialProviderKey = 'google' | 'microsoft' | 'facebook'

export const SOCIAL_PROVIDER_LABEL: Record<SocialProviderKey, string> = {
  google:    'Google',
  microsoft: 'Microsoft',
  facebook:  'Facebook',
}

// Firebase's providerId strings ↔ our keys, so an existing sign-in method reported by
// fetchSignInMethodsForEmail can be mapped back to a provider (or to 'password').
const PROVIDER_ID: Record<SocialProviderKey, string> = {
  google:    'google.com',
  microsoft: 'microsoft.com',
  facebook:  'facebook.com',
}

function buildProvider(key: SocialProviderKey): AuthProvider {
  switch (key) {
    case 'google': {
      const p = new GoogleAuthProvider()
      p.setCustomParameters({ prompt: 'select_account' })
      return p
    }
    case 'microsoft': {
      const p = new OAuthProvider('microsoft.com')
      p.setCustomParameters({ prompt: 'select_account' })
      return p
    }
    case 'facebook':
      return new FacebookAuthProvider()
  }
}

// Extract the credential of the ATTEMPTED provider from a collision error, so it can
// be linked onto the existing account after the user re-authenticates.
function pendingCredentialFromError(key: SocialProviderKey, err: FirebaseError): AuthCredential | null {
  switch (key) {
    case 'google':    return GoogleAuthProvider.credentialFromError(err)
    case 'microsoft': return OAuthProvider.credentialFromError(err)
    case 'facebook':  return FacebookAuthProvider.credentialFromError(err)
  }
}

/** Map a fetchSignInMethodsForEmail entry to our provider key, or 'password'/null. */
export function methodToProviderKey(method: string): SocialProviderKey | 'password' | null {
  if (method === 'password') return 'password'
  const entry = (Object.entries(PROVIDER_ID) as [SocialProviderKey, string][])
    .find(([, id]) => id === method)
  return entry ? entry[0] : null
}

// ─── Sign-in ──────────────────────────────────────────────────────────────────

export type SocialSignInResult =
  | { status: 'signed-in';  user: User }
  | {
      status:            'needs-link'
      email:             string
      methods:           string[]
      pendingCredential: AuthCredential
      providerKey:       SocialProviderKey
    }

/**
 * Start social sign-in via popup. Returns { status: 'signed-in' } on success. When the
 * email already belongs to a different sign-in method, returns { status: 'needs-link' }
 * with the pending credential + the existing methods so the caller can complete linking
 * (never creating a duplicate account). Throws any other Firebase error for mapAuthError.
 */
export async function signInWithSocial(key: SocialProviderKey): Promise<SocialSignInResult> {
  // Social sessions persist across restarts like the default email/password login.
  await setPersistence(auth, browserLocalPersistence)
  try {
    const cred = await signInWithPopup(auth, buildProvider(key))
    return { status: 'signed-in', user: cred.user }
  } catch (err) {
    if (err instanceof FirebaseError && err.code === 'auth/account-exists-with-different-credential') {
      const email = typeof err.customData?.email === 'string' ? err.customData.email : ''
      const pendingCredential = pendingCredentialFromError(key, err)
      if (email && pendingCredential) {
        const methods = await fetchSignInMethodsForEmail(auth, email)
        return { status: 'needs-link', email, methods, pendingCredential, providerKey: key }
      }
    }
    throw err
  }
}

// ─── Linking ────────────────────────────────────────────────────────────────

/**
 * Complete linking when the existing account uses email/password: re-authenticate with
 * the password, then attach the pending social credential to that SAME account. The uid
 * is unchanged, so the organizer keeps their single identity/profile.
 */
export async function linkPendingCredentialWithPassword(
  email:             string,
  password:          string,
  pendingCredential: AuthCredential,
): Promise<User> {
  const { user } = await signInWithEmailAndPassword(auth, email, password)
  await linkWithCredential(user, pendingCredential)
  return user
}

/**
 * Complete linking when the existing account uses another OAuth provider: sign in with
 * that provider via popup, then attach the pending credential to the same account.
 */
export async function linkPendingCredentialWithProvider(
  existingKey:       SocialProviderKey,
  pendingCredential: AuthCredential,
): Promise<User> {
  const { user } = await signInWithPopup(auth, buildProvider(existingKey))
  await linkWithCredential(user, pendingCredential)
  return user
}
