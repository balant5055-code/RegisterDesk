'use client'

// RD-AUTH-01 Phase 1 (M-A): the ONE canonical client-side authentication source.
//
// The whole app is wrapped in <AuthProvider> (root layout), which owns EXACTLY ONE
// onAuthStateChanged + ONE onIdTokenChanged listener for the entire client. Every
// component reads the shared user + token via useAuth() instead of subscribing to
// Firebase independently — eliminating the duplicated listeners/state/token work
// the audit flagged. Behaviour is identical; only the wiring is centralised.

import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { onAuthStateChanged, onIdTokenChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'

export interface AuthContextValue {
  /** undefined = auth still resolving · null = signed out · User = signed in. */
  user: User | null | undefined
  /**
   * Reactive fresh ID token, kept current by onIdTokenChanged (silent ~hourly refresh
   * + revocation). undefined = resolving · null = signed out · string = current token.
   * Consumers that previously kept their own onIdTokenChanged-refreshed token read this.
   */
  token: string | null | undefined
  /** Imperative fresh ID token for the current user (null when signed out). Pass true to force-refresh. */
  getToken: (forceRefresh?: boolean) => Promise<string | null>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // undefined until the first listener callback fires (Firebase resolves cached state
  // synchronously-ish, no network round-trip), then null | User.
  const [user,  setUser]  = useState<User | null | undefined>(undefined)
  const [token, setToken] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    // onAuthStateChanged: sign-in / sign-out + identity.
    const unsubAuth = onAuthStateChanged(auth, u => setUser(u))

    // onIdTokenChanged: sign-in/out + every silent token refresh (~hourly) + revocation.
    // It owns the shared token cache (Firebase reuses the same User object on a refresh,
    // so `user` identity alone can't signal a token change — `token` does). It also feeds
    // `user`, so the two listeners agree; a same-reference setUser is a no-op re-render.
    let cancelled = false
    const unsubToken = onIdTokenChanged(auth, async u => {
      setUser(u)
      if (!u) { setToken(null); return }
      const t = await u.getIdToken()
      if (!cancelled) setToken(t)
    })

    return () => { cancelled = true; unsubAuth(); unsubToken() }
  }, [])

  const getToken = useCallback(
    (forceRefresh = false): Promise<string | null> =>
      auth.currentUser ? auth.currentUser.getIdToken(forceRefresh) : Promise.resolve(null),
    [],
  )

  return <AuthContext.Provider value={{ user, token, getToken }}>{children}</AuthContext.Provider>
}

/** The ONE client auth hook. Must be used within <AuthProvider> (mounted at the app root). */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() must be used within <AuthProvider>')
  return ctx
}
