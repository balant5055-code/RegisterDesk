// Financial Integrity Phase 1 — the pure bucket rules of a refund reversal (no Firestore).

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const { walletBucketForRelease, computeReversalDebit } = await import('@/lib/firebase/firestore/revenueWallets')

describe('walletBucketForRelease', () => {
  it('maps the authoritative releaseStatus to the bucket holding the net', () => {
    expect(walletBucketForRelease('released')).toBe('available')
    expect(walletBucketForRelease('pending')).toBe('pending')
    expect(walletBucketForRelease('held')).toBe('pending')            // a refund hold keeps the net in pending
  })
  it('returns null (fail closed) for anything else — never a guess', () => {
    for (const v of [undefined, null, '', 'RELEASED', 'settled', 1, {}]) expect(walletBucketForRelease(v)).toBeNull()
  })
})

describe('computeReversalDebit', () => {
  const w = { pendingPaise: 700, availablePaise: 1_000 }
  it('debits ONLY the named bucket', () => {
    expect(computeReversalDebit(w, 1_000, 'available')).toEqual({ fromPending: 0, fromAvailable: 1_000, totalDebited: 1_000 })
    expect(computeReversalDebit(w, 500, 'pending')).toEqual({ fromPending: 500, fromAvailable: 0, totalDebited: 500 })
  })
  it('clamps a shortfall in that bucket and NEVER takes the rest from the other bucket', () => {
    expect(computeReversalDebit(w, 1_500, 'available')).toEqual({ fromPending: 0, fromAvailable: 1_000, totalDebited: 1_000 })
    expect(computeReversalDebit(w, 900, 'pending')).toEqual({ fromPending: 700, fromAvailable: 0, totalDebited: 700 })
  })
  it('never debits a negative or missing balance, nor a negative amount', () => {
    expect(computeReversalDebit({ pendingPaise: -50, availablePaise: 0 }, 100, 'pending').totalDebited).toBe(0)
    expect(computeReversalDebit({ pendingPaise: undefined as unknown as number, availablePaise: 0 }, 100, 'pending').totalDebited).toBe(0)
    expect(computeReversalDebit(w, -10, 'available').totalDebited).toBe(0)
  })
})
