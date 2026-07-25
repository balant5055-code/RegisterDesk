import type { User } from 'firebase/auth'
import { ROUTES } from '@/config/navigation'

// RD-AUTH-01 Phase 4 (H-C): the ONE canonical client-side navigation decision for
// authenticated organizer surfaces. Pure and deterministic — it maps the canonical
// auth state (from AuthProvider / useAuth) to a single decision, so every protected
// organizer route (the dashboard layout and /welcome) navigates from the SAME source
// in the SAME order:
//
//   authentication resolution → email verification → authorized
//
// Crucially it decides NOTHING until auth has resolved (undefined = still resolving →
// wait). That single rule eliminates the /welcome onboarding race, which previously
// read auth.currentUser synchronously on mount and bounced a genuinely-authenticated
// user to /login before Firebase had finished restoring the session.
//
// Admin surfaces layer their server-side RBAC check on the SAME auth source (useAuth)
// but intentionally use a different decision (no email-verification gate, admin-login
// target) and are therefore not governed by this organizer resolver.

export type AuthGuardStatus = 'resolving' | 'redirect' | 'authorized'

export interface AuthGuardDecision {
  status: AuthGuardStatus
  /** Destination to navigate to when status === 'redirect'; otherwise null. */
  redirect: string | null
}

export function resolveAuthGuard(user: User | null | undefined): AuthGuardDecision {
  if (user === undefined)   return { status: 'resolving',  redirect: null }                // auth still resolving — decide nothing
  if (user === null)        return { status: 'redirect',   redirect: ROUTES.LOGIN }         // signed out
  if (!user.emailVerified)  return { status: 'redirect',   redirect: ROUTES.VERIFY_EMAIL }  // signed in, email not verified
  return { status: 'authorized', redirect: null }
}
