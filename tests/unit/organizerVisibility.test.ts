// Organizer visibility — the pure rules behind the admin organizer list, detail popup and
// Organizer 360: verification state read honestly, legacy records, safe dates, and money
// that is withheld (redacted) never rendering as zero or crashing. Plus the source wiring
// that the social sign-in creates its profile before routing.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// financialGuard imports the admin auth module (Admin SDK) for its request-level helpers;
// the redaction function under test is pure and needs none of it.
vi.mock('@/lib/admin/auth', () => ({ legacyAdminClaimOnly: vi.fn(), resolveSuperAdminUid: vi.fn() }))
import { join } from 'node:path'
import {
  resolveEmailVerification, isPendingVerification, isStatusRecorded, resolveAccountStatus,
} from '@/lib/admin/organizerTypes'
import {
  fmtSafeDate, statusText, emailVerificationLabel, mobileLabel, trustLabel, rupees,
  walletAmountLabel, payoutLabel, WITHHELD,
} from '@/lib/admin/organizerDisplay'
import { redactFinancialFields } from '@/lib/admin/financialGuard'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('verification state is read as recorded, never assumed', () => {
  it('explicit true / false, nested or flat', () => {
    expect(resolveEmailVerification({ emailVerified: true })).toBe('verified')
    expect(resolveEmailVerification({ verification: { email: { verified: true } } })).toBe('verified')
    expect(resolveEmailVerification({ emailVerified: false })).toBe('unverified')
    expect(resolveEmailVerification({ verification: { email: { verified: false } } })).toBe('unverified')
  })

  it('absent fields are unknown, not verified', () => {
    expect(resolveEmailVerification({})).toBe('unknown')
    expect(resolveEmailVerification(null)).toBe('unknown')
    expect(resolveEmailVerification({ verification: 'garbage', emailVerified: 'yes' })).toBe('unknown')
  })

  it('pending verification = pending status OR an explicitly unverified email', () => {
    expect(isPendingVerification('pending', 'unknown')).toBe(true)
    expect(isPendingVerification('active', 'unverified')).toBe(true)
    expect(isPendingVerification('active', 'verified')).toBe(false)
    // a legacy record with nothing recorded is NOT badged
    expect(isPendingVerification('active', 'unknown')).toBe(false)
  })

  it('a legacy record without accountStatus: effective active, reported not recorded', () => {
    expect(resolveAccountStatus(undefined)).toBe('active')
    expect(isStatusRecorded(undefined)).toBe(false)
    expect(isStatusRecorded('weird')).toBe(false)
    for (const s of ['active', 'pending', 'suspended', 'banned']) expect(isStatusRecorded(s)).toBe(true)
    expect(statusText('active', false)).toBe('active (no status recorded)')
    expect(statusText('pending', true)).toBe('pending')
  })
})

describe('display labels distinguish missing / unverified / not recorded', () => {
  it('dates: missing or invalid never render "Invalid Date"', () => {
    expect(fmtSafeDate(null)).toBe('—')
    expect(fmtSafeDate('')).toBe('—')
    expect(fmtSafeDate('not-a-date')).toBe('—')
    expect(fmtSafeDate(12345)).toBe('—')
    expect(fmtSafeDate('2026-10-01T10:00:00.000Z')).toMatch(/2026/)
    expect(fmtSafeDate('2026-10-01T10:00:00.000Z', true)).toMatch(/2026/)
  })

  it('email verification', () => {
    expect(emailVerificationLabel('verified')).toBe('Verified')
    expect(emailVerificationLabel('unverified')).toBe('Unverified')
    expect(emailVerificationLabel('unknown')).toBe('Not recorded')
    expect(emailVerificationLabel(undefined)).toBe('Not recorded')
  })

  it('mobile', () => {
    expect(mobileLabel(null, 'missing')).toBe('Not provided')
    expect(mobileLabel('+919000000001', 'verified')).toBe('+919000000001 · verified')
    expect(mobileLabel('+919000000001', 'unverified')).toBe('+919000000001 · not verified')
  })

  it('trust', () => {
    expect(trustLabel(null)).toBe('Not recorded')
    expect(trustLabel({ level: null, score: null })).toBe('Not recorded')
    expect(trustLabel({ level: 'email_verified', score: 45 })).toBe('email verified · score 45')
    expect(trustLabel({ level: 'unverified', score: null })).toBe('unverified')
  })
})

describe('redacted or absent money never crashes and never reads as zero', () => {
  it('rupees: non-numbers are a dash', () => {
    expect(rupees(null)).toBe('—')
    expect(rupees(undefined)).toBe('—')
    expect(rupees('100')).toBe('—')
    expect(rupees(NaN)).toBe('—')
    expect(rupees(12345)).toMatch(/^₹123\.45$/)
  })

  it('wallet and payout under the real redaction function', () => {
    const detail = {
      profile: { uid: 'u', name: 'N' },
      wallet: { exists: true, availablePaise: 500, pendingPaise: 0, settledPaise: 100, inTransitPaise: 0 },
      payoutProfile: { exists: true, isVerified: true, payoutMethod: 'bank', verifiedAt: null },
      settlements: [{ id: 's1', amountPaise: 100, status: 'paid', requestedAt: null }],
    }
    const r = redactFinancialFields(detail)
    expect(r.wallet).toBeNull()
    expect(r.payoutProfile).toBeNull()
    expect(r.settlements).toEqual([])
    expect(walletAmountLabel(r.wallet, 'availablePaise', true)).toBe(WITHHELD)
    expect(walletAmountLabel(r.wallet, 'availablePaise', false)).toBe(WITHHELD)   // null alone ⇒ withheld
    expect(payoutLabel(r.payoutProfile, true)).toBe(WITHHELD)
    expect(payoutLabel(null, false)).toBe(WITHHELD)
    // nothing sensitive survives in the redacted copy
    expect(JSON.stringify(r)).not.toMatch(/bank|500|amountPaise":100/)
  })

  it('unredacted: no wallet / no payout / amounts', () => {
    expect(walletAmountLabel({ exists: false, availablePaise: 0 }, 'availablePaise', false)).toBe('—')
    expect(walletAmountLabel({ exists: true, availablePaise: 500 }, 'availablePaise', false)).toBe('₹5.00')
    expect(walletAmountLabel(undefined, 'availablePaise', false)).toBe('—')
    expect(payoutLabel({ exists: false, isVerified: false }, false)).toBe('Not set up')
    expect(payoutLabel({ exists: true, isVerified: false }, false)).toBe('Not verified')
    expect(payoutLabel({ exists: true, isVerified: true }, false)).toBe('Verified')
    expect(payoutLabel('missing', false)).toBe('Not set up')
    expect(payoutLabel('verified', false)).toBe('Verified')
  })

  it('a redacted 360 overview keeps its non-money fields and nulls the money', () => {
    const overview = {
      revenue: { availablePaise: 1, settledPaise: 2, pendingPaise: 3, inTransitPaise: 4 },
      licenses: { active: 1, revenuePaise: 900 },
      verification: { emailVerified: true, payoutExists: true, payoutVerified: true, payoutMethod: 'upi',
        email: { state: 'verified', method: 'otp', verifiedAt: null } },
      onboarding: { checks: [{ id: 'logo', label: 'Logo', done: true }], done: 1, total: 6, payout: 'verified' },
      trust: { level: 'email_verified', score: 45 },
    }
    const r = redactFinancialFields(overview)
    expect(r.revenue).toBeNull()
    expect(r.licenses.revenuePaise).toBeNull()
    expect(r.verification.payoutMethod).toBeNull()
    expect(r.onboarding.payout).toBeNull()
    expect(r.onboarding.checks).toHaveLength(1)
    expect(r.verification.email.state).toBe('verified')
    expect(r.trust).toEqual({ level: 'email_verified', score: 45 })
    expect(payoutLabel(r.onboarding.payout, false)).toBe(WITHHELD)
    expect(rupees(r.revenue?.availablePaise)).toBe('—')
  })
})

describe('wiring', () => {
  it('the 360 console reads revenue null-safely', () => {
    const src = read('app/(admin)/admin/organizers/[organizerUid]/PageClient.tsx')
    expect(src).not.toMatch(/o\.revenue\.\w/)
    expect(src).toContain('o.revenue?.availablePaise')
  })

  it('the detail popup no longer dereferences wallet / payoutProfile directly', () => {
    const src = read('app/(admin)/admin/organizers/PageClient.tsx')
    expect(src).not.toMatch(/detail\.wallet\.\w/)
    expect(src).not.toMatch(/detail\.payoutProfile\.\w/)
    expect(src).toContain('Signed up:')
  })

  it('every social sign-in path ensures the profile BEFORE routing', () => {
    const src = read('app/(auth)/login/page.tsx')
    const calls = src.match(/await ensureSocialOrganizerProfile\((result\.user|user)\)\s*\n\s*await routeAfterAuth\(/g) ?? []
    expect(calls).toHaveLength(3)
  })

  it('the social-profile route reuses the one idempotent seam and refuses staff / team members', () => {
    const src = read('app/api/auth/social-profile/route.ts')
    expect(src).toContain("import { ensureOrganizerProfile } from '@/lib/organizer/ensureProfile'")
    expect(src).toContain('verifyIdToken(bearer, true)')
    expect(src).toContain("return done('staff')")
    expect(src).toContain("return done('team_member')")
    expect(src).toContain("return done('exists')")
    // it never writes users/{uid} itself
    expect(src).not.toMatch(/\.set\(|\.update\(|\.create\(/)
  })
})
