// Phase C — Cashfree vendor preparation: the data model and the local review workflow.
//
// ═══ THE CLAIM THIS FILE REFUSES TO LET US MAKE ═════════════════════════════
// That a RegisterDesk admin reviewing a payout profile means Cashfree has approved the
// organizer. It does not. Three separate things exist and only the first two are ours:
//
//   profile supplied  →  locally reviewed  →  [ vendor created + KYC approved AT CASHFREE ]
//   \___ organizer ___/   \____ admin ____/    \______ only Cashfree can say this ______/
//
// Every case below pins one side or the other of that line.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  readVendorPreparationStatus, readVendorKycStatus, readCashfreeVendorId,
  canAdminTransition, allowedAdminTransitions, hasReviewablePayoutProfile,
  VENDOR_PREPARATION_STATUSES,
} from '@/lib/payout/vendorStatus'

// ─── Reading stored state ─────────────────────────────────────────────────────

describe('stored vendor state is read conservatively', () => {
  it('a historical profile with NO vendor metadata is readable and reads as not_started', () => {
    // Every existing document is this shape. Nothing was migrated.
    expect(readVendorPreparationStatus(undefined)).toBe('not_started')
    expect(readCashfreeVendorId(undefined)).toBeNull()
    expect(readVendorKycStatus(undefined)).toBe('unknown')
  })

  it('malformed or unknown status values NEVER read as reviewed', () => {
    // The conservative direction: "reviewed" is the state that lets an organizer progress,
    // so an unreadable value must not grant it.
    for (const bad of [null, '', 'REVIEWED', 'locally-reviewed', 'approved', 0, {}, [], true]) {
      expect(readVendorPreparationStatus(bad), `${JSON.stringify(bad)}`).toBe('not_started')
    }
  })

  it('every declared status round-trips', () => {
    for (const s of VENDOR_PREPARATION_STATUSES) expect(readVendorPreparationStatus(s)).toBe(s)
  })

  it('a vendor id is only ever a real, non-blank string', () => {
    expect(readCashfreeVendorId('vendor_123')).toBe('vendor_123')
    expect(readCashfreeVendorId('  vendor_123  ')).toBe('vendor_123')
    for (const bad of ['', '   ', null, undefined, 0, {}, false]) {
      expect(readCashfreeVendorId(bad), `${JSON.stringify(bad)} must not be an id`).toBeNull()
    }
  })
})

// ─── The KYC status cannot be fabricated ─────────────────────────────────────

describe('Cashfree KYC status cannot be invented', () => {
  it('reads as unknown whatever is stored — including plausible Cashfree-looking values', () => {
    // If someone hand-writes 'APPROVED' into Firestore, it must not read back as approval.
    for (const v of ['APPROVED', 'ACTIVE', 'VERIFIED', 'PENDING', 'unknown', null, undefined, 1]) {
      expect(readVendorKycStatus(v)).toBe('unknown')
    }
  })

  it('the type admits exactly one value, so no fabricated status can be written', () => {
    const src = readFileSync('lib/payout/vendorStatus.ts', 'utf8')
    expect(src).toMatch(/export type VendorKycStatus = 'unknown'/)
    // Comments stripped: the module NAMES these values in prose precisely to explain why it
    // refuses to invent them, and quoting a thing you are forbidding is not doing it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
    for (const invented of ['APPROVED', 'PENDING', 'IN_REVIEW', 'ACTIVE', 'REJECTED']) {
      expect(code, `must not invent Cashfree status ${invented}`).not.toContain(`'${invented}'`)
    }
  })
})

// ─── Transitions ──────────────────────────────────────────────────────────────

describe('local review transitions', () => {
  it('an admin may review or return a submitted profile', () => {
    expect(canAdminTransition('profile_submitted', 'locally_reviewed')).toBe(true)
    expect(canAdminTransition('profile_submitted', 'changes_requested')).toBe(true)
  })

  it('a review can be revoked, and a returned profile re-reviewed', () => {
    expect(canAdminTransition('locally_reviewed', 'changes_requested')).toBe(true)
    expect(canAdminTransition('changes_requested', 'locally_reviewed')).toBe(true)
  })

  it('nothing can be reviewed before a profile exists', () => {
    for (const to of VENDOR_PREPARATION_STATUSES) {
      expect(canAdminTransition('not_started', to), `not_started → ${to}`).toBe(false)
    }
    expect(allowedAdminTransitions('not_started')).toEqual([])
  })

  it('an admin cannot move a profile BACK to submitted or not_started', () => {
    // Those are organizer-driven / derived states, not review outcomes.
    for (const from of VENDOR_PREPARATION_STATUSES) {
      expect(canAdminTransition(from, 'profile_submitted'), `${from} → profile_submitted`).toBe(false)
      expect(canAdminTransition(from, 'not_started'), `${from} → not_started`).toBe(false)
    }
  })

  it('a status is never a no-op transition to itself', () => {
    for (const s of VENDOR_PREPARATION_STATUSES) expect(canAdminTransition(s, s)).toBe(false)
  })
})

// ─── Reviewability is derived from the profile ───────────────────────────────

describe('there must be something to review', () => {
  const BANK = { payoutMethod: 'bank', accountNumber: '123456', ifscCode: 'HDFC0001', panNumber: 'ABCDE1234F' }
  const UPI  = { payoutMethod: 'upi',  upiId: 'a@okhdfc', panNumber: 'ABCDE1234F' }

  it('a complete bank or UPI profile is reviewable', () => {
    expect(hasReviewablePayoutProfile(BANK)).toBe(true)
    expect(hasReviewablePayoutProfile(UPI)).toBe(true)
  })

  it('an incomplete profile is not', () => {
    expect(hasReviewablePayoutProfile(null)).toBe(false)
    expect(hasReviewablePayoutProfile({})).toBe(false)
    expect(hasReviewablePayoutProfile({ ...BANK, panNumber: '' })).toBe(false)
    expect(hasReviewablePayoutProfile({ ...BANK, ifscCode: '' })).toBe(false)
    expect(hasReviewablePayoutProfile({ ...UPI, upiId: '   ' })).toBe(false)
    expect(hasReviewablePayoutProfile({ ...BANK, payoutMethod: 'cheque' })).toBe(false)
  })
})

// ─── The admin route ──────────────────────────────────────────────────────────

describe('the admin review route', () => {
  const src = readFileSync('app/api/admin/payout-profiles/[uid]/route.ts', 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')

  it('is admin-gated, on the server, before anything is written', () => {
    // RD-PHASE4-S4 · D1 — the gate is now the shared Super Admin guard (built on resolveSuperAdminUid).
    expect(code).toMatch(/requireSuperAdmin\(/)
    const guard = code.indexOf('requireSuperAdmin(')
    const firstWrite = Math.min(...['batch.update(', 'tx.update('].map(w => code.indexOf(w)).filter(i => i >= 0))
    expect(guard).toBeLessThan(firstWrite)
  })

  it('a local review NEVER writes vendor identity or KYC', () => {
    // The heart of Phase C. The review block may write only OUR status fields.
    const block = code.slice(code.indexOf('if (isVendorAction)'), code.indexOf('// ── Write ──'))
    expect(block).toMatch(/vendorStatus:\s+next/)
    expect(block).toMatch(/vendorReviewedBy:\s+adminUid/)
    for (const forbidden of ['cashfreeVendorId', 'vendorKycStatus', 'vendorCreatedAt', 'vendorLastSyncedAt']) {
      expect(block, `a local review must not write ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('refuses an unsupported transition and an unreviewable profile', () => {
    expect(code).toMatch(/canAdminTransition\(current, next\)/)
    expect(code).toMatch(/hasReviewablePayoutProfile\(profile\)/)
    expect(code).toMatch(/status: 409/)
  })

  it('requires a reason and audits the previous and new status', () => {
    expect(code).toMatch(/if \(!reviewNote\)/)
    expect(code).toMatch(/previousStatus: current, newStatus: next, reviewNote/)
    expect(code).toMatch(/adminUid,/)
  })

  it('the existing verify / reject workflow is untouched', () => {
    expect(code).toMatch(/action === 'verify'/)
    expect(code).toMatch(/isVerified:\s+true/)
    expect(code).toMatch(/rejectionNote is required when rejecting/)
  })
})

// ─── The organizer cannot self-approve ───────────────────────────────────────

describe('an organizer cannot grant themselves anything', () => {
  const src = readFileSync('app/api/organizer/payout-profile/route.ts', 'utf8')

  it('vendor fields are copied from the STORED doc, never from the request', () => {
    // Each carried field reads from `existingData`, so a crafted request body cannot set it.
    for (const f of ['cashfreeVendorId', 'vendorKycStatus', 'vendorCreatedAt', 'vendorLastSyncedAt']) {
      expect(src, `${f} must come from existingData`).toMatch(new RegExp(`existingData\\?\\.${f}`))
      expect(src, `${f} must not be read from the body`).not.toMatch(new RegExp(`body\\.${f}`))
    }
  })

  it('editing payout details resets the LOCAL review, exactly as it resets isVerified', () => {
    // The review was of the old details. New details have not been reviewed by anyone.
    expect(src).toMatch(/vendorStatus:\s+'profile_submitted'/)
    expect(src).toMatch(/vendorReviewedBy: null/)
    expect(src).toMatch(/isVerified:\s+false/)
  })

  it('the full-document overwrite cannot silently destroy a vendor id', () => {
    // The write is `.set()`, not a merge: a field not restated is deleted. This is the
    // regression that would lose an organizer's Cashfree identity on a typo fix.
    expect(src).toMatch(/batch\.set\(docRef, docData\)/)
    expect(src).toMatch(/cashfreeVendorId:\s+existingData\.cashfreeVendorId/)
  })
})

// ─── Isolation ────────────────────────────────────────────────────────────────

describe('Phase C makes no external calls and touches no payment routing', () => {
  const files = [
    'lib/payout/vendorStatus.ts',
    'app/api/admin/payout-profiles/[uid]/route.ts',
    'app/api/organizer/payout-profile/route.ts',
  ]

  it('no Cashfree API call, endpoint or adapter is referenced', () => {
    for (const f of files) {
      const s = readFileSync(f, 'utf8')
      for (const forbidden of ['cashfreeAdapter', 'cashfree.com', '/pg/', 'x-client-secret', 'fetch(']) {
        expect(s, `${f} must not contain ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('payment gateway routing is not touched', () => {
    for (const f of files) {
      const s = readFileSync(f, 'utf8')
      expect(s).not.toContain('resolveActivePaymentProviderForNewOrder')
      expect(s).not.toContain('activeProvider')
    }
  })

  it('no sensitive field is duplicated into vendor metadata', () => {
    const types = readFileSync('lib/payout/types.ts', 'utf8')
    const block = types.slice(types.indexOf('cashfreeVendorId?:'), types.indexOf('vendorReviewNote?:'))
    for (const sensitive of ['accountNumber', 'ifscCode', 'panNumber', 'gstNumber', 'upiId']) {
      expect(block, `vendor metadata must not carry ${sensitive}`).not.toContain(sensitive)
    }
  })
})
