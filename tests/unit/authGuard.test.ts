// RD-AUTH-01 Phase 4 (H-C) — the canonical client-side navigation decision.
//
// resolveAuthGuard is the ONE source of the authentication→navigation decision shared
// by the dashboard layout and /welcome. These cases pin every branch, including the
// rule that fixes the onboarding race: it must NOT decide before auth has resolved
// (undefined = resolving), which is distinct from null (signed out → redirect).

import { describe, it, expect } from 'vitest'
import type { User } from 'firebase/auth'
import { resolveAuthGuard } from '@/lib/auth/authGuard'
import { ROUTES } from '@/config/navigation'

const asUser = (o: Partial<User>) => o as User

describe('resolveAuthGuard — canonical auth → navigation decision', () => {
  it('undefined (auth still resolving) → resolving, no redirect', () => {
    expect(resolveAuthGuard(undefined)).toEqual({ status: 'resolving', redirect: null })
  })

  it('null (signed out) → redirect to login', () => {
    expect(resolveAuthGuard(null)).toEqual({ status: 'redirect', redirect: ROUTES.LOGIN })
  })

  it('signed in but email NOT verified → redirect to verify-email', () => {
    expect(resolveAuthGuard(asUser({ emailVerified: false })))
      .toEqual({ status: 'redirect', redirect: ROUTES.VERIFY_EMAIL })
  })

  it('signed in and verified → authorized, no redirect', () => {
    expect(resolveAuthGuard(asUser({ emailVerified: true })))
      .toEqual({ status: 'authorized', redirect: null })
  })

  it('never decides before auth resolves — undefined is distinct from null (the /welcome race)', () => {
    expect(resolveAuthGuard(undefined).status).toBe('resolving')
    expect(resolveAuthGuard(undefined).redirect).toBeNull()
    expect(resolveAuthGuard(null).status).toBe('redirect')
  })
})
